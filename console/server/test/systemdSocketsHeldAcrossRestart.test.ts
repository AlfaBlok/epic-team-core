import net from "node:net";
import { describe, expect, it } from "vitest";
import { inheritedSockets, serveOn } from "../src/systemdSockets.js";

// systemd holds the console's listening sockets across a release's restart; the console takes them by name.
describe("systemd socket activation", () => {
  it("reads the passed sockets by FileDescriptorName, only when LISTEN_PID is this process", () => {
    const env = { LISTEN_PID: "42", LISTEN_FDS: "2", LISTEN_FDNAMES: "web:gateway" };
    expect([...inheritedSockets(env, 42)]).toEqual([["web", 3], ["gateway", 4]]);
    expect(inheritedSockets(env, 7).size).toBe(0); // a child of the unit's process (tsx): fd 3 is not the socket
    expect(inheritedSockets({}, 42).size).toBe(0); // not socket-activated: bind as before
    expect([...inheritedSockets({ LISTEN_PID: "42", LISTEN_FDS: "1" }, 42)]).toEqual([["fd3", 3]]);
  });

  it("serveOn binds its own port when no socket of that name was passed", async () => {
    const server = serveOn(new Map(), "web", { fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    const { port } = server.address() as net.AddressInfo;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    await new Promise((r) => server.close(r));
  });
});
