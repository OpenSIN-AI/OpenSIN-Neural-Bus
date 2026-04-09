import { connect, NatsConnection, StringCodec, JetStreamClient } from 'nats';

export interface NeuralEvent {
  topic: string;
  source: string;
  timestamp: number;
  payload: any;
}

export class NeuralBus {
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private sc = StringCodec();

  async connect(url: string, token: string) {
    this.nc = await connect({ servers: url, token });
    this.js = this.nc.jetstream();
    console.log(`[Neural-Bus] Connected to ${url}`);
  }

  async emit(topic: string, source: string, payload: any) {
    if (!this.js) throw new Error("Not connected");
    const event: NeuralEvent = { topic, source, timestamp: Date.now(), payload };
    await this.js.publish(topic, this.sc.encode(JSON.stringify(event)));
  }

  async listen(topic: string, callback: (event: NeuralEvent) => void) {
    if (!this.nc) throw new Error("Not connected");
    const sub = this.nc.subscribe(topic);
    for await (const msg of sub) {
      try {
        const event = JSON.parse(this.sc.decode(msg.data)) as NeuralEvent;
        callback(event);
      } catch (e) {
        console.error("[Neural-Bus] Failed to parse event", e);
      }
    }
  }

  async close() {
    await this.nc?.close();
  }
}
