import { describe, expect, it } from "vitest";
import {
  sanitizeSyncPayload,
  SyncError,
  UNAMBIGUOUS_SYNC_TOKEN_PATTERN_SOURCE,
  type Json,
} from "../src/index.js";

describe("sanitizeSyncPayload", () => {
  it.each([
    ["api key", { apiKey: "abc123" }],
    ["token", { nested: { pairingToken: "abc123" } }],
    ["credential", { account: { credentialHint: "present" } }],
  ])("rejects payloads with a denied %s key", (_name, payload) => {
    expectBoundaryViolation(() => sanitizeSyncPayload("appSettings", payload));
  });

  it.each(["key", "keys", "keyCode", "keybinding", "keybindings", "binding", "bindings"])(
    "allows exact keybindings key-name property %s",
    (field) => {
      expect(sanitizeSyncPayload("keybindings", { [field]: "Mod+O" })).toEqual({
        [field]: "Mod+O",
      });
    },
  );

  it("allows real keybinding payloads", () => {
    const payload = {
      bindings: [{ key: "Mod+O", command: "openFile" }],
    };

    expect(sanitizeSyncPayload("keybindings", payload)).toEqual(payload);
  });

  it("allows long keybinding shortcut strings without entropy rejection", () => {
    const payload = {
      bindings: [{ key: "Ctrl+Shift+Alt+Option+Command+Meta+Super+Mod+F12", command: "save" }],
    };

    expect(sanitizeSyncPayload("keybindings", payload)).toEqual(payload);
  });

  it("still applies token-prefix checks to keybinding shortcut strings", () => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("keybindings", {
        bindings: [{ key: "Ctrl+sk_test_secret", command: "save" }],
      }),
    );
  });

  it.each(["apiKey", "keybindingToken", "keybindingPassword"])(
    "still rejects sensitive key name %s inside keybindings",
    (field) => {
      expectBoundaryViolation(() =>
        sanitizeSyncPayload("keybindings", {
          bindings: [{ [field]: "abc123", command: "openFile" }],
        }),
      );
    },
  );

  it("rejects env-style secret labels", () => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("operatorConfig", {
        env: [{ name: "API_KEY", value: "abc" }],
      }),
    );
  });

  it("checks every label-like field in labeled values", () => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("operatorConfig", {
        env: [{ name: "display", label: "API_KEY", value: "abc" }],
      }),
    );
  });

  it("allows clean labeled values", () => {
    expect(
      sanitizeSyncPayload("operatorConfig", {
        env: [{ name: "theme", value: "dark" }],
      }),
    ).toEqual({
      env: [{ name: "theme", value: "dark" }],
    });
  });

  it.each([
    ["Stripe live key", "sk_live_abc"],
    ["Stripe test key", "sk_test_abc"],
    ["Stripe webhook secret", "whsec_abc"],
    ["GitHub personal access token", "ghp_abc"],
    ["GitHub OAuth token", "gho_abc"],
    ["Slack bot token", "xoxb-abc"],
    ["AWS access key", "AKIA1234567890ABCDEF"],
  ])("rejects unambiguous %s prefixes anywhere in string values", (_name, token) => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("operatorConfig", { value: `prefix ${token} suffix` }),
    );
  });

  it("exports the token pattern used by migration parity tests", () => {
    expect(UNAMBIGUOUS_SYNC_TOKEN_PATTERN_SOURCE).toBe(
      "(sk_live_|sk_test_|whsec_|ghp_|gho_|xoxb-|AKIA[0-9A-Z]{16})",
    );
  });

  it.each([
    ["POSIX", "/Users/me/.pickforge"],
    ["Windows", "C:\\Users\\me\\.pickforge"],
    ["Windows forward slash", "D:/pickforge"],
    ["UNC", "\\\\server\\share\\pickforge"],
    ["extended Windows", "\\\\?\\C:\\Users\\me\\.pickforge"],
  ])("rejects absolute %s paths outside remote roots", (_name, path) => {
    expectBoundaryViolation(() => sanitizeSyncPayload("appSettings", { recentLocation: path }));
  });

  it.each([
    ["POSIX", "cd /Users/me/app && run"],
    ["generic POSIX", "ROOT=/srv/pickforge"],
    ["Windows drive", "ROOT=C:\\Users\\me\\app"],
    ["Windows drive with forward slash", "ROOT=C:/Program Files/Pickforge"],
    ["UNC", "open \\\\server\\share\\pickforge"],
  ])("rejects embedded absolute %s paths", (_name, value) => {
    expectBoundaryViolation(() => sanitizeSyncPayload("operatorConfig", { command: value }));
  });

  it("does not treat URL paths as embedded local paths", () => {
    expect(sanitizeSyncPayload("operatorConfig", { homepage: "https://x/home/page" })).toEqual({
      homepage: "https://x/home/page",
    });
  });

  it("allows common slash text that is not a local path", () => {
    const payload = { note: "release 07/09 and/or later" };

    expect(sanitizeSyncPayload("operatorConfig", payload)).toEqual(payload);
  });

  it("rejects file URLs with local absolute paths", () => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("operatorConfig", { command: "open file:///srv/pickforge" }),
    );
  });

  it("rejects absolute paths used as object keys", () => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("appSettings", {
        "/Users/me/app": { enabled: true },
      }),
    );
  });

  it("still scans path-looking keys inside keybindings", () => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("keybindings", {
        "/Users/me/app": "Mod+O",
      }),
    );
  });

  it("allows remoteBindings remoteRoot absolute paths", () => {
    const payload = {
      profiles: [{ name: "prod", remoteRoot: "/srv/pickforge" }],
    } satisfies Json;

    expect(sanitizeSyncPayload("remoteBindings", payload)).toEqual(payload);
  });

  it.each([
    ["drive", "D:\\pickforge\\workspace"],
    ["UNC", "\\\\server\\share\\pickforge"],
    ["extended", "\\\\?\\C:\\pickforge"],
  ])("rejects %s paths in remoteBindings remoteRoot", (_name, remoteRoot) => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("remoteBindings", {
        profiles: [{ name: "windows", remoteRoot }],
      }),
    );
  });

  it("still rejects non-remoteRoot absolute paths in remoteBindings", () => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("remoteBindings", {
        profiles: [{ name: "prod", localRoot: "/Users/me/pickforge" }],
      }),
    );
  });

  it("catches nested offenders", () => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("operatorConfig", {
        panes: [{ command: { env: [{ value: "ghp_nested" }] } }],
      }),
    );
  });

  it("rejects long mixed-class token-like strings", () => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("appSettings", {
        cacheId: "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk",
      }),
    );
  });

  it("rejects serial-like strings", () => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("operatorConfig", {
        deviceLabel: "serial: ABC1234567",
      }),
    );
  });

  it("allows clean payloads", () => {
    const payload = {
      theme: "dark",
      zoom: 1,
      panes: [{ title: "Editor", visible: true }],
      recentProjectNames: ["platform", "desktop"],
    } satisfies Json;

    expect(sanitizeSyncPayload("appSettings", payload)).toEqual(payload);
  });

  it("normalizes toJSON before scanning", () => {
    expectBoundaryViolation(() =>
      sanitizeSyncPayload("appSettings", {
        toJSON: () => ({ value: "sk_test_from_to_json" }),
      }),
    );
  });

  it("returns the normalized payload", () => {
    expect(
      sanitizeSyncPayload("appSettings", {
        toJSON: () => ({ theme: "dark" }),
      }),
    ).toEqual({ theme: "dark" });
  });

  it.each([undefined, () => ({ theme: "dark" })])("rejects non-plain top-level payloads", (payload) => {
    expectBoundaryViolation(() => sanitizeSyncPayload("appSettings", payload));
  });
});

function expectBoundaryViolation(fn: () => unknown): void {
  let thrown: unknown;

  try {
    fn();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(SyncError);
  expect(thrown).toMatchObject({ code: "boundary_violation" });
}
