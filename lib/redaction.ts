/**
 * Email redaction for machine-readable command output.
 *
 * Account labels are built from the operator-visible email, so any command that
 * emits them as JSON hands that address to whatever consumes the output: log
 * shippers, dashboards, ticket attachments. `forecast --json` has masked them
 * since it was written; this module is that same masking, shared so other JSON
 * surfaces do not each re-derive it.
 */

/**
 * Mask one address, keeping just enough to tell two accounts apart: the first
 * two characters of the local part and the TLD.
 */
export function maskEmail(value: string): string {
	const atIndex = value.indexOf("@");
	if (atIndex <= 0) return "***@***";
	const local = value.slice(0, atIndex);
	const domain = value.slice(atIndex + 1);
	const domainParts = domain.split(".");
	const tld = domainParts.pop() ?? "";
	const prefix = local.slice(0, Math.min(2, local.length));
	return `${prefix}***@***.${tld || "***"}`;
}

/** Mask every address embedded in a free-text string. */
export function redactEmails(value: string): string {
	return value.replace(
		/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
		(match) => maskEmail(match),
	);
}
