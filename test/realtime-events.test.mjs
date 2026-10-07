import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createFactoryEventBroker } from "../web-server.mjs";

test("factory event broker streams invalidation topics and cleans up clients", () => {
  const broker = createFactoryEventBroker({ watch: false });
  const req = new EventEmitter();
  const chunks = [];
  const res = {
    writeHead(status, headers) { assert.equal(status, 200); assert.match(headers["content-type"], /text\/event-stream/); },
    write(chunk) { chunks.push(String(chunk)); },
    end() {},
  };
  broker.handle(req, res);
  assert.equal(broker.clientCount, 1);
  broker.publish(["workers", "talk"], { source: "test" });
  const output = chunks.join("");
  assert.match(output, /event: ready/);
  assert.match(output, /event: factory/);
  assert.match(output, /"topics":\["workers","talk"\]/);
  req.emit("close");
  assert.equal(broker.clientCount, 0);
  broker.close();
});
