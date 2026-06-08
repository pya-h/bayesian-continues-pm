// Realtime publish bus. Holds a reference to the running Bun server and publishes
// JSON messages to topic channels that WS clients subscribe to. Domain services
// (trade/belief/lp/settlement) call `publish(topic, payload)` in later phases.
// Topic conventions: `market:<id>`, `user:<id>`, `system`.

interface Publisher {
  publish(topic: string, data: string): void;
}

let server: Publisher | null = null;

export function setServer(s: Publisher | null): void {
  server = s;
}

export function publish(topic: string, payload: unknown): void {
  server?.publish(topic, JSON.stringify(payload));
}

export const topics = {
  market: (id: string) => `market:${id}`,
  user: (id: string) => `user:${id}`,
  system: 'system',
};
