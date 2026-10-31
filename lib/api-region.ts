/** Closed list: credentials must never follow arbitrary endpoints or redirects. */
export function apiBaseUrl(route: { region?: "global" | "us" }): string {
 if (route.region === "us") return "https://us.api.openai.com/v1";
 if (route.region === undefined || route.region === "global") return "https://api.openai.com/v1";
 throw new Error("Invalid API region");
}
