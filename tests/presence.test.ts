import { describe, test, expect, beforeEach } from "bun:test";
import { initDatabase } from "../server/src/db";
import { updateEventState } from "../server/src/ledger";
import { handleStateRequest, getStatePayload } from "../server/src/routes/state";
import { handleDonationRequest } from "../server/src/routes/donation";
import {
  handlePresenceRequest,
  recordHeartbeat,
  getPresenceView,
  resetPresence,
  classifyDevice,
  PRESENCE_TTL_MS
} from "../server/src/presence";
import type { Database } from "bun:sqlite";
import { authed, operatorCookie } from "./auth-helper";

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
describe("Live Presence Registry", () => {
  let db: Database;
  let cookie: string;

  beforeEach(async () => {
    db = initDatabase(":memory:");
    resetPresence();
    cookie = await operatorCookie(db);
  });

  async function post(body: unknown, opts: { ua?: string } = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.ua) headers["User-Agent"] = opts.ua;
    const req = new Request("http://localhost:3000/api/presence", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body)
    });
    return handlePresenceRequest(req, db);
  }

  async function getRoster() {
    return handlePresenceRequest(authed(new Request("http://localhost:3000/api/presence"), cookie), db);
  }

  test("heartbeat registers an entry and reports it on the roster", async () => {
    const res = await post({ client_id: "c-alpha", name: "Ashraf", surface: "donations" }, { ua: DESKTOP_UA });
    expect(res.status).toBe(200);
    const ack = await res.json();
    expect(ack.ok).toBe(true);
    expect(ack.name).toBe("Ashraf");
    expect(ack.device).toBe("desktop");

    const roster = await (await getRoster()).json();
    expect(roster.count).toBe(1);
    expect(roster.entries[0].client_id).toBe("c-alpha");
    expect(roster.entries[0].surface).toBe("donations");
    expect(roster.entries[0].device).toBe("desktop");
  });

  test("two clients on different surfaces share one roster", async () => {
    await post({ client_id: "c-alpha", name: "Ashraf", surface: "donations" }, { ua: DESKTOP_UA });
    await post({ client_id: "c-bravo", name: "V-1234", surface: "add" }, { ua: PHONE_UA });
    await post({ client_id: "c-charlie", name: "Ballroom", surface: "chart" }, { ua: DESKTOP_UA });

    const roster = await (await getRoster()).json();
    expect(roster.count).toBe(3);
    const bySurface: Record<string, string> = {};
    for (const entry of roster.entries) bySurface[entry.surface] = entry.name;
    expect(bySurface).toEqual({ donations: "Ashraf", add: "V-1234", chart: "Ballroom" });
    // The projector reports even though it never displays the panel.
    expect(roster.entries.find((e: { surface: string }) => e.surface === "chart").device).toBe("desktop");
  });

  test("a second heartbeat from the same client id updates instead of duplicating", async () => {
    const first = recordHeartbeat({ client_id: "c-alpha", name: "Ashraf", surface: "add" }, DESKTOP_UA, 1_000);
    expect(first.ok).toBe(true);

    const second = recordHeartbeat({ client_id: "c-alpha", name: "Ashraf B", surface: "donations" }, DESKTOP_UA, 4_000);
    expect(second.ok).toBe(true);

    const view = getPresenceView(4_000);
    expect(view.count).toBe(1);
    expect(view.entries[0].surface).toBe("donations");
    expect(view.entries[0].name).toBe("Ashraf B");
    // Navigating between surfaces must not reset "connected since".
    expect(view.entries[0].first_seen).toBe(1_000);
    expect(view.entries[0].last_seen).toBe(4_000);
  });

  test("an entry past its TTL is absent from a read with no intervening write", () => {
    recordHeartbeat({ client_id: "c-alpha", name: "Ashraf", surface: "donations" }, DESKTOP_UA, 10_000);
    expect(getPresenceView(10_000 + PRESENCE_TTL_MS).count).toBe(1);
    // No write happens between these two reads. Expiry is evaluated on read,
    // so the closed laptop cannot linger as a phantom operator.
    expect(getPresenceView(10_000 + PRESENCE_TTL_MS + 1).count).toBe(0);
    expect(getPresenceView(10_000 + PRESENCE_TTL_MS + 1).entries).toEqual([]);
  });

  test("an expired client rejoins with a fresh first_seen", () => {
    recordHeartbeat({ client_id: "c-alpha", name: "Ashraf", surface: "donations" }, DESKTOP_UA, 1_000);
    expect(getPresenceView(1_000 + PRESENCE_TTL_MS + 1).count).toBe(0);
    recordHeartbeat({ client_id: "c-alpha", name: "Ashraf", surface: "donations" }, DESKTOP_UA, 50_000);
    const view = getPresenceView(50_000);
    expect(view.count).toBe(1);
    expect(view.entries[0].first_seen).toBe(50_000);
  });

  test("an unknown surface is rejected 400", async () => {
    const res = await post({ client_id: "c-alpha", name: "Ashraf", surface: "kitchen" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_SURFACE");
    expect(getPresenceView().count).toBe(0);
  });

  test("a missing or unusable surface is rejected 400", async () => {
    expect((await post({ client_id: "c-alpha", name: "Ashraf" })).status).toBe(400);
    expect((await post({ client_id: "c-alpha", name: "Ashraf", surface: 7 })).status).toBe(400);
    expect((await post({ client_id: "c-alpha", name: "Ashraf", surface: ["add"] })).status).toBe(400);
    expect(getPresenceView().count).toBe(0);
  });

  test("a malformed or non-object body is rejected 400", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post("[]")).status).toBe(400);
    expect((await post('"add"')).status).toBe(400);
    expect(getPresenceView().count).toBe(0);
  });

  test("an oversized body is rejected 413 and never registered", async () => {
    const res = await post({ client_id: "c-alpha", name: "Ashraf", surface: "add", junk: "x".repeat(4096) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("PAYLOAD_TOO_LARGE");
    expect(getPresenceView().count).toBe(0);
  });

  test("an out-of-range client id or name is rejected 400", async () => {
    expect((await post({ client_id: "ab", name: "Ashraf", surface: "add" })).status).toBe(400);
    expect((await post({ client_id: "x".repeat(65), name: "Ashraf", surface: "add" })).status).toBe(400);
    expect((await post({ client_id: "c-alpha", name: "   ", surface: "add" })).status).toBe(400);
    expect((await post({ client_id: "c-alpha", name: "n".repeat(200), surface: "add" })).status).toBe(400);
    expect(getPresenceView().count).toBe(0);
  });

  test("a display name is scrubbed of markup and capped", async () => {
    const res = await post({
      client_id: "c-alpha",
      name: '  <script>alert(1)</script>   Ashraf\u0000  ',
      surface: "donations"
    });
    expect(res.status).toBe(200);
    const stored = getPresenceView().entries[0].name;
    expect(stored).not.toContain("<");
    expect(stored).not.toContain(">");
    expect(stored.length).toBeLessThanOrEqual(32);
    expect(stored).toContain("Ashraf");
  });

  test("device class comes from the user-agent, never from the body", async () => {
    await post({ client_id: "c-alpha", name: "Pad", surface: "add", device: "desktop" }, { ua: PHONE_UA });
    expect(getPresenceView().entries[0].device).toBe("phone");

    expect(classifyDevice(DESKTOP_UA)).toBe("desktop");
    expect(classifyDevice(PHONE_UA)).toBe("phone");
    expect(classifyDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1")).toBe("tablet");
    expect(classifyDevice("Mozilla/5.0 (Linux; Android 14; SM-S911B) Mobile Safari/537.36")).toBe("phone");
    expect(classifyDevice("Mozilla/5.0 (Linux; Android 14; SM-X710) Safari/537.36")).toBe("tablet");
    expect(classifyDevice(null)).toBe("desktop");
  });

  test("a registered entry never stores the raw user-agent", async () => {
    await post({ client_id: "c-alpha", name: "Ashraf", surface: "donations" }, { ua: DESKTOP_UA });
    const serialized = JSON.stringify(getPresenceView());
    expect(serialized).not.toContain("Mozilla");
    expect(serialized).not.toContain("AppleWebKit");
    expect(Object.keys(getPresenceView().entries[0]).sort()).toEqual([
      "client_id",
      "device",
      "first_seen",
      "last_seen",
      "name",
      "surface"
    ]);
  });

  test("presence rides the control role payload", async () => {
    await post({ client_id: "c-alpha", name: "Ashraf", surface: "donations" }, { ua: DESKTOP_UA });
    const res = handleStateRequest(authed(new Request("http://localhost:3000/api/state?role=control"), cookie), db);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.presence.count).toBe(1);
    expect(data.presence.entries[0].name).toBe("Ashraf");
    expect(data.presence.heartbeat_ms).toBe(5000);
    expect(data.presence.ttl_ms).toBe(PRESENCE_TTL_MS);
  });

  test("presence rides the default role payload for signed-in operators only", async () => {
    await post({ client_id: "c-alpha", name: "Ashraf", surface: "home" }, { ua: DESKTOP_UA });
    expect((await handleStateRequest(new Request("http://localhost:3000/api/state?role=all"), db).json()).presence).toBeUndefined();
    const data = await handleStateRequest(authed(new Request("http://localhost:3000/api/state?role=all"), cookie), db).json();
    expect(data.presence.count).toBe(1);
  });

  test("roster and operator state require sign-in; heartbeats stay public", async () => {
    await post({ client_id: "c-alpha", name: "Ashraf", surface: "donations" }, { ua: DESKTOP_UA });
    expect((await getRoster()).status).toBe(200);
    expect(handleStateRequest(new Request("http://localhost:3000/api/state?role=control"), db).status).toBe(401);
    const authedControl = authed(new Request("http://localhost:3000/api/state?role=control"), cookie);
    expect(handleStateRequest(authedControl, db).status).toBe(200);

    const unauthed = new Request("http://localhost:3000/api/presence");
    expect((await handlePresenceRequest(unauthed, db)).status).toBe(401);
  });

  test("heartbeating never requires sign-in, so a gated event still reports its projector", async () => {
    const res = await post({ client_id: "c-chart", name: "Ballroom", surface: "chart" }, { ua: DESKTOP_UA });
    expect(res.status).toBe(200);
    expect(getPresenceView().count).toBe(1);
  });


  test("no presence payload ever carries donor data, PINs, or API keys", async () => {
    updateEventState(db, { bloomerang_api_key: "blm_live_SECRETKEY" });
    const donation = authed(new Request("http://localhost:3000/api/donation/don_presence_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_cents: 500000,
        donor_name: "Senator Marcus",
        card_number: "#0777",
        entered_by: "V-1234"
      })
    }), cookie);
    expect((await handleDonationRequest(donation, db, ["api", "donation", "don_presence_1"])).status).toBe(201);

    await post({ client_id: "c-alpha", name: "Ashraf", surface: "donations" }, { ua: DESKTOP_UA });

    const fromApi = await (await getRoster()).text();
    const authedControl = authed(new Request("http://localhost:3000/api/state?role=control"), cookie);
    const controlPayload = getStatePayload("control", db, 0, authedControl).payload;
    if (!controlPayload || typeof controlPayload !== "object" || !("presence" in controlPayload)) {
      throw new Error("control payload is missing presence");
    }
    const fromState = JSON.stringify(controlPayload.presence);
    const ackBody = await (
      await post({ client_id: "c-alpha", name: "Ashraf", surface: "donations" }, { ua: DESKTOP_UA })
    ).text();

    for (const serialized of [fromApi, fromState, ackBody]) {
      expect(serialized).not.toContain("Senator Marcus");
      expect(serialized).not.toContain("0777");
      expect(serialized).not.toContain("blm_live_SECRETKEY");
      expect(serialized).not.toContain("bloomerang");
      expect(serialized).not.toContain("pin_hash");
    }
  });

  test("a non-POST, non-GET method is rejected 405", async () => {
    const req = new Request("http://localhost:3000/api/presence", { method: "DELETE" });
    expect((await handlePresenceRequest(req, db)).status).toBe(405);
  });

  test("presence never touches the ledger", async () => {
    const seqBefore = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ledger`).get()!.n;
    await post({ client_id: "c-alpha", name: "Ashraf", surface: "donations" }, { ua: DESKTOP_UA });
    await post({ client_id: "c-bravo", name: "V-9", surface: "add" }, { ua: PHONE_UA });
    getPresenceView();
    const seqAfter = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ledger`).get()!.n;
    expect(seqAfter).toBe(seqBefore);
  });
});
