import { fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";

import type { Store } from "@/lib/stores";

import type { Call } from "./fetch";
import { mockApi, reply } from "./fetch";

export const STORE_A: Store = { id: "st-a", name: "Store A", whatsapp_number: "+96170000031", has_logo: true, status: "active" };
export const STORE_B: Store = { id: "st-b", name: "Store B", whatsapp_number: "+96170000032", has_logo: false, status: "active" };
export const STORE_C: Store = { id: "st-c", name: "Store C", whatsapp_number: null, has_logo: false, status: "inactive" };

/** Mocks GET /stores with `stores` and sends every other call to `handler` (404 when it is not given). */
export function storesApi(stores: Store[], handler: (call: Call) => Response | Promise<Response> = () => reply(404)): Call[] {
  return mockApi((call) => {
    if (call.url === "/api/v1/stores" && call.method === "GET") return reply(200, stores);
    return handler(call);
  });
}

export const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");

/** A stand-in for XMLHttpRequest: the test decides when the upload progresses and how the server answers. */
export class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  form: FormData | null = null;
  withCredentials = false;
  responseType = "";
  status = 0;
  response = "";
  aborted = false;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.form = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body?: unknown) {
    this.status = status;
    this.response = body === undefined ? "" : JSON.stringify(body);
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
}

export function installFakeXhr() {
  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
}

export const lastUpload = () => {
  const xhr = FakeXhr.instances[FakeXhr.instances.length - 1];
  if (!xhr) throw new Error("No upload was started");
  return xhr;
};

export function imageFile(name = "logo.png", type = "image/png", size = 12): File {
  const file = new File([new Uint8Array(12)], name, { type });
  if (size !== 12) Object.defineProperty(file, "size", { value: size });
  return file;
}

export function chooseLogo(file: File) {
  fireEvent.change(screen.getByTestId("logo-input"), { target: { files: [file] } });
}
