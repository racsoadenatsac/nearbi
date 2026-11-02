// Tests must never touch the network. fetch is replaced with a thrower; outbound sockets are refused
// unless DYNAMODB_ENDPOINT points the optional DynamoDB Local contract run at a local container.
import net from "node:net";

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network disabled in tests (fetch ${String(input)})`);
}) as typeof fetch;

const allowedHost = process.env.DYNAMODB_ENDPOINT ? new URL(process.env.DYNAMODB_ENDPOINT).hostname : null;
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  // net.connect()/http pass a pre-normalized [options, cb] array as the first argument.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = first as { host?: string; path?: string } | number | string;
  const host = typeof opts === "object" && opts ? (opts.host ?? (opts.path ? "unix" : "localhost")) : String(args[1] ?? "localhost");
  if (host !== "unix" && host !== allowedHost) throw new Error(`network disabled in tests (connect ${host})`);
  return (origConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;
