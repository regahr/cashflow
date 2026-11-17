// Thin Slack Web API client and request signature check. No SDK.

export async function verifySlack(req: Request, body: string, signingSecret: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false; // replay guard
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  const hex = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Slack {
  private token: string;
  private base: string;
  constructor(token: string, base = "https://slack.com/api") {
    this.token = token;
    this.base = base;
  }

  async call(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(args),
    });
    const json = await res.json();
    if (!json.ok) console.error(`slack ${method} failed`, json.error);
    return json;
  }

  async post(channel: string, text: string, threadTs?: string): Promise<string | undefined> {
    const r = await this.call("chat.postMessage", { channel, text, thread_ts: threadTs, unfurl_links: false });
    return r.ts as string | undefined;
  }

  update(channel: string, ts: string, text: string) {
    return this.call("chat.update", { channel, ts, text });
  }

  react(channel: string, ts: string, name: string) {
    return this.call("reactions.add", { channel, timestamp: ts, name });
  }

  /** Upload a text file to a channel (files.getUploadURLExternal + completeUploadExternal). */
  async uploadText(channel: string, filename: string, content: string, comment: string) {
    const bytes = new TextEncoder().encode(content);
    const form = new URLSearchParams({ filename, length: String(bytes.length) });
    const r1 = await fetch(`${this.base}/files.getUploadURLExternal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    }).then((r) => r.json());
    if (!r1.ok) return console.error("upload url failed", r1.error);
    await fetch(r1.upload_url, { method: "POST", body: bytes });
    await this.call("files.completeUploadExternal", {
      files: [{ id: r1.file_id, title: filename }],
      channel_id: channel,
      initial_comment: comment,
    });
  }
}
