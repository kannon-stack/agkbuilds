import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
import { CONTACT_EMAIL, quoteBody, quoteMailto, type QuoteRequest } from "@/lib/quote";

const needs = [
  "Computer repair",
  "Custom PC build",
  "Data recovery",
  "Locked out of my computer",
  "Website",
  "Cleanup or upgrade",
  "Something else",
];

const empty: QuoteRequest = { name: "", email: "", device: needs[0], details: "", reach: "" };

/**
 * The site has no mail server, so submitting opens an email draft in the visitor's
 * own app. The confirmation says so, and offers a copy button if nothing opens.
 */
export function QuoteForm() {
  const [request, setRequest] = useState<QuoteRequest>(empty);
  const [drafted, setDrafted] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const field = (key: keyof QuoteRequest) => ({
    id: `q-${key}`,
    name: key,
    value: request[key],
    onChange: (event: { target: { value: string } }) =>
      setRequest((current) => ({ ...current, [key]: event.target.value })),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    window.location.href = quoteMailto(request);
    setCopyState("idle");
    setDrafted(true);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(quoteBody(request));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="quote-panel">
      <span className="corner corner-tl" aria-hidden="true">+</span>
      <span className="corner corner-tr" aria-hidden="true">+</span>
      <span className="corner corner-bl" aria-hidden="true">+</span>
      <span className="corner corner-br" aria-hidden="true">+</span>

      {drafted ? (
        <div role="status" className="quote-done">
          <Mail size={32} aria-hidden="true" />
          <h3>One more step: press Send</h3>
          <p>Your email app should open with your request filled in. <strong>Nothing is sent until you press Send there.</strong></p>
          <p>If nothing opened, copy your request and email it to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
          <div className="quote-done-actions">
            <button type="button" className="btn btn-primary" onClick={copy}>{copyState === "copied" ? "Copied" : "Copy my request"}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setDrafted(false)}>Edit request</button>
          </div>
          {copyState === "failed" && (
            <textarea className="fld" readOnly value={quoteBody(request)} aria-label="Your request, ready to copy" onFocus={(event) => event.target.select()} />
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="quote-form">
          <label htmlFor="q-name">Name
            <input className="fld" type="text" required maxLength={80} autoComplete="name" placeholder="Your name" {...field("name")} />
          </label>
          <label htmlFor="q-email">Email
            <input className="fld" type="email" required maxLength={120} autoComplete="email" placeholder="you@example.com" {...field("email")} />
          </label>
          <label htmlFor="q-device">What do you need?
            <select className="fld" {...field("device")}>
              {needs.map((need) => <option key={need}>{need}</option>)}
            </select>
          </label>
          <label htmlFor="q-details">What is going on?
            <textarea className="fld" required maxLength={1200} placeholder="Device make and model, what it is doing, and when it started." {...field("details")} />
          </label>
          <label htmlFor="q-reach">Best way to reach you (optional)
            <input className="fld" type="text" maxLength={120} placeholder="Email is fine, or tell us a good time" {...field("reach")} />
          </label>
          <button className="btn btn-primary btn-lg" type="submit">Open email draft</button>
          <p className="form-note">This opens your email app with your answers filled in. Nothing is sent until you press Send.</p>
        </form>
      )}
    </div>
  );
}
