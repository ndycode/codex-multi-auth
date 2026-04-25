export function isRateLimitedMarker(marker: string): boolean {
	return marker === "rate-limited" || marker.startsWith("rate-limited:");
}
