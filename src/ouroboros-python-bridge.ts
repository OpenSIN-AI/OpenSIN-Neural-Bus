/**
 * ==============================================================================
 * OpenSIN Neural Bus - Ouroboros Python Bridge
 * ==============================================================================
 *
 * DESCRIPTION:
 * Thin Node bridge that invokes the Python Ouroboros CLI and returns typed JSON.
 *
 * WHY:
 * The capability registry and lesson store already live in the Python SDK. This
 * bridge lets the OpenCode-facing MCP server reuse that source of truth instead
 * of duplicating SQLite logic in TypeScript.
 *
 * CONSEQUENCES:
 * Node callers must have Python available, but in return the TypeScript and
 * Python surfaces stay aligned around one registry implementation.
 * ==============================================================================
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  ProceduralLesson,
  QueryCapabilitiesInput,
  QueryLessonsInput,
  RegisteredCapability,
  RegisterCapabilityInput,
  RememberLessonInput,
} from './types';
import { validateNonEmptyString, validateOptionalPositiveInteger } from './validation';

const execFileAsync = promisify(execFile);

/**
 * Bridge options let tests point to a temporary database and let operators swap
 * the Python executable when their environment needs something non-default.
 */
export interface OuroborosPythonBridgeOptions {
  pythonExecutable?: string;
  pythonModulePath?: string;
  dbPath?: string;
}

/**
 * Minimal Python bridge for capability and lesson operations.
 */
export class OuroborosPythonBridge {
  private readonly pythonExecutable: string;
  private readonly pythonModulePath: string;
  private readonly pythonCliPath: string;
  private readonly dbPath?: string;

  constructor(options: OuroborosPythonBridgeOptions = {}) {
    const repoRoot = path.resolve(__dirname, '..', '..');

    this.pythonExecutable = options.pythonExecutable ?? process.env.OUROBOROS_PYTHON ?? 'python3';
    this.pythonModulePath = options.pythonModulePath ?? path.join(repoRoot, 'sdk', 'python');
    this.pythonCliPath = path.join(this.pythonModulePath, 'ouroboros', 'cli.py');
    this.dbPath = options.dbPath ?? process.env.OUROBOROS_DB_PATH;
  }

  /**
   * Shared subprocess execution helper. Every CLI path returns JSON so the MCP
   * layer never has to scrape human-formatted stdout.
   */
  private async runCli(commandArgs: string[]): Promise<unknown> {
    const env = {
      ...process.env,
      PYTHONPATH: [this.pythonModulePath, process.env.PYTHONPATH]
        .filter((value): value is string => Boolean(value))
        .join(path.delimiter),
    };

    const { stdout } = await execFileAsync(this.pythonExecutable, [this.pythonCliPath, ...commandArgs], {
      env,
    });

    return JSON.parse(stdout);
  }

  /**
   * Capability registration powers the fleet's reusable tool memory.
   */
  async registerCapability(input: RegisterCapabilityInput): Promise<RegisteredCapability> {
    const args = [
      'register-capability',
      '--capability',
      validateNonEmptyString(input.capability, 'capability'),
      '--path',
      validateNonEmptyString(input.path, 'path'),
      '--agent',
      validateNonEmptyString(input.agent, 'agent'),
    ];

    if (this.dbPath) {
      args.push('--db-path', this.dbPath);
    }

    const response = (await this.runCli(args)) as { capability: RegisteredCapability };
    return response.capability;
  }

  /**
   * Query capability records with an optional keyword filter.
   */
  async queryCapabilities(input: QueryCapabilitiesInput = {}): Promise<RegisteredCapability[]> {
    const args = ['query-capabilities', '--limit', String(validateOptionalPositiveInteger(input.limit, 'limit', 20))];

    if (input.keyword) {
      args.push('--keyword', validateNonEmptyString(input.keyword, 'keyword'));
    }

    if (this.dbPath) {
      args.push('--db-path', this.dbPath);
    }

    const response = (await this.runCli(args)) as { capabilities: RegisteredCapability[] };
    return response.capabilities;
  }

  /**
   * Query recent procedural lessons so operators can pull swarm memory into an
   * OpenCode session without retyping the historical context.
   */
  async queryRecentLessons(input: QueryLessonsInput = {}): Promise<ProceduralLesson[]> {
    const args = ['query-lessons', '--limit', String(validateOptionalPositiveInteger(input.limit, 'limit', 5))];

    if (input.keyword) {
      args.push('--keyword', validateNonEmptyString(input.keyword, 'keyword'));
    }

    if (this.dbPath) {
      args.push('--db-path', this.dbPath);
    }

    const response = (await this.runCli(args)) as { lessons: ProceduralLesson[] };
    return response.lessons;
  }

  /**
   * Internal helper used by tests to seed procedural memory with deterministic
   * fixtures before exercising the query tools.
   */
  async rememberLesson(input: RememberLessonInput): Promise<ProceduralLesson> {
    const args = [
      'remember-lesson',
      '--agent-id',
      validateNonEmptyString(input.agentId, 'agentId'),
      '--context',
      validateNonEmptyString(input.context, 'context'),
      '--lesson',
      validateNonEmptyString(input.lesson, 'lesson'),
      '--success-rate',
      String(input.successRate ?? 1),
    ];

    if (this.dbPath) {
      args.push('--db-path', this.dbPath);
    }

    const response = (await this.runCli(args)) as { lesson: ProceduralLesson };
    return response.lesson;
  }
}
