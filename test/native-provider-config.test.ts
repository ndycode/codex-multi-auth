import { describe, it, expect } from "vitest";
import {
	rewriteNativeProviderConfig,
	restoreNativeProviderConfig,
} from "../lib/runtime/native-provider-config.js";
describe("native provider binding", () => {
	it("keeps OAuth enabled without changing unrelated configuration and restores prior routing", () => {
		const original =
			'model_provider = "prior"\nopenai_base_url = "https://example.test/v1"\nmodel = "future-model"\n[features]\nfoo = true\n';
		const bound = rewriteNativeProviderConfig(
			original,
			"http://127.0.0.1:43210",
		);
		expect(bound).toContain('model_provider = "openai"');
		expect(bound).not.toContain("requires_openai_auth = false");
		expect(bound).toContain('openai_base_url = "http://127.0.0.1:43210"');
		expect(bound).toContain("[features]\nfoo = true");
		expect(rewriteNativeProviderConfig(bound, "http://127.0.0.1:43210")).toBe(
			bound,
		);
		const restored = restoreNativeProviderConfig(
			bound.replace("foo = true", "foo = false"),
			original,
		);
		expect(restored).toContain('model_provider = "prior"');
		expect(restored).toContain('openai_base_url = "https://example.test/v1"');
		expect(restored).toContain("foo = false");
		expect(restored).not.toContain("43210");
	});
	it("rejects non-loopback proxy URLs", () => {
		expect(() =>
			rewriteNativeProviderConfig("", "https://evil.test"),
		).toThrow();
	});
});

it("routes only the voice sideband through the loopback proxy and removes it on unbind (#750)",()=>{
 const original='model = "fixture-model"\n';
 const bound=rewriteNativeProviderConfig(original,"http://127.0.0.1:43210");
 // Call creation already follows openai_base_url; only the sideband socket
 // needs redirecting, and never to anything but the loopback proxy.
 expect(bound).toContain('experimental_realtime_ws_base_url = "http://127.0.0.1:43210" # codex-multi-auth realtime sideband');
 expect(bound).not.toContain("experimental_realtime_webrtc_call_base_url");
 expect(rewriteNativeProviderConfig(bound,"http://127.0.0.1:43210")).toBe(bound);
 expect(restoreNativeProviderConfig(bound,original)).not.toContain("experimental_realtime_");
});
it("replaces a marked sideband line left outside the native block",()=>{
 const original='experimental_realtime_ws_base_url = "http://127.0.0.1:1" # codex-multi-auth realtime sideband\nmodel = "x"\n';
 const bound=rewriteNativeProviderConfig(original,"http://127.0.0.1:43210");
 expect(bound).toContain('experimental_realtime_ws_base_url = "http://127.0.0.1:43210"');
 expect(bound.match(/experimental_realtime_ws_base_url/g)).toHaveLength(1);
});
it("preserves explicit voice endpoint overrides through bind and unbind",()=>{
 const original='experimental_realtime_ws_base_url = "https://example.test/voice"\n';
 const bound=rewriteNativeProviderConfig(original,"http://127.0.0.1:43210");
 expect(bound.match(/experimental_realtime_ws_base_url/g)).toHaveLength(1);
 expect(restoreNativeProviderConfig(bound,original)).toContain(original.trim());
});
