export const CONTACT_EMAIL = "agkbuilds@gmail.com";

export type QuoteRequest = {
  name: string;
  email: string;
  device: string;
  details: string;
  reach: string;
};

export function quoteSubject({ device, name }: QuoteRequest) {
  return `Quote request: ${device} (${name.trim()})`;
}

export function quoteBody({ name, email, device, details, reach }: QuoteRequest) {
  const lines = [
    `Name: ${name.trim()}`,
    `Email: ${email.trim()}`,
    `Needs: ${device}`,
  ];
  if (reach.trim()) lines.push(`Best way to reach me: ${reach.trim()}`);
  lines.push("", "What is going on:", details.trim().replace(/\r?\n/g, "\r\n"));
  return lines.join("\r\n");
}

/** A link that opens the visitor's email app with the request filled in. */
export function quoteMailto(request: QuoteRequest) {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(quoteSubject(request))}&body=${encodeURIComponent(quoteBody(request))}`;
}
