import type { ServerResponse } from "node:http";
import type { SseEvent, SseEventType } from "./protocol.ts";

export class SseHub {
  private next = 1;
  private readonly ring: SseEvent[] = [];
  private readonly clients = new Set<ServerResponse>();

  constructor(private readonly capacity = 256) {}

  get clientCount(): number {
    return this.clients.size;
  }

  emit(type: SseEventType, data: unknown): SseEvent {
    const event = { id: this.next++, type, data };
    this.ring.push(event);
    if (this.ring.length > this.capacity) this.ring.shift();

    const text = this.format(event);
    for (const client of this.clients) {
      if (!this.write(client, text)) this.clients.delete(client);
    }
    return event;
  }

  since(id: number): SseEvent[] {
    return this.ring.filter((event) => event.id > id);
  }

  unicast(response: ServerResponse, type: SseEventType, data: unknown): boolean {
    return this.write(
      response,
      `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  }

  connect(response: ServerResponse, since: number): () => void {
    if (this.isDead(response)) return () => {};

    this.clients.add(response);
    for (const event of this.since(since)) {
      if (!this.write(response, this.format(event))) {
        this.clients.delete(response);
        break;
      }
    }
    return () => this.clients.delete(response);
  }

  close(): void {
    this.emit("bye", {});
    for (const client of this.clients) {
      try {
        if (!this.isDead(client)) client.end();
      } catch {
        // The client is already gone.
      }
    }
    this.clients.clear();
  }

  private write(response: ServerResponse, text: string): boolean {
    if (this.isDead(response)) return false;
    try {
      response.write(text);
      return true;
    } catch {
      return false;
    }
  }

  private isDead(response: ServerResponse): boolean {
    return response.destroyed || response.writableEnded;
  }

  private format(event: SseEvent): string {
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  }
}
