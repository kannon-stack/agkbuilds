import { ArrowRight, Check, Cpu, Globe, HardDrive, Lock, Mail, SlidersHorizontal, Wrench } from "lucide-react";
import { AsciiEye, AsciiFlames, AsciiLogo, HatchBars, RuleLine, SparkleDivider } from "@/components/Ascii";
import { QuoteForm } from "@/components/QuoteForm";
import { CONTACT_EMAIL } from "@/lib/quote";
import { BASE_FLAMES, HERO_FLAMES } from "@/lib/asciiArt";

const navLinks = [
  { href: "#services", label: "Services" },
  { href: "#builds", label: "Builds" },
  { href: "#process", label: "Process" },
  { href: "#community", label: "Community" },
];

const facts = [
  { label: "Local", text: "Based in San Antonio, Texas." },
  { label: "Diagnosis first", text: "You hear what is wrong before anything is fixed." },
  { label: "Clear quotes", text: "You approve the price before work starts." },
  { label: "Your data stays yours", text: "Files are handled with care and returned to you." },
];

const services = [
  { icon: Wrench, title: "Computer repair", text: "Laptops and desktops that will not boot, run slow, overheat, or have failing parts. Diagnosed first, fixed once." },
  { icon: Cpu, title: "Custom PC builds", text: "Gaming, creative, and home-office machines chosen for your budget, built clean, and tested before handoff." },
  { icon: HardDrive, title: "Data recovery", text: "Files back from failing, damaged, or unreadable drives. If a drive is clicking or not showing up, stop using it and get in touch." },
  { icon: Lock, title: "Locked out?", text: "We help you get back into your own computer, where it can be done without losing your files. Proof of ownership required." },
  { icon: Globe, title: "Websites", text: "Clean, fast sites for small businesses: one clear page that explains what you do and how to reach you." },
  { icon: SlidersHorizontal, title: "Cleanup and upgrades", text: "Slow or cluttered machines cleaned up, plus SSD and RAM upgrades and new-PC setup with your files moved over." },
];

const buildTypes = [
  "Gaming rigs",
  "Creative and workstation machines",
  "Home and office computers",
  "Upgrades to a PC you already own",
];

const steps = [
  { title: "Tell us what is wrong", text: "Send the quote form or an email with the device and the problem. Photos of error messages help." },
  { title: "We diagnose and quote", text: "You get a plain answer on what is wrong, what it takes to fix, and what it costs." },
  { title: "You approve, we fix", text: "Work starts only after you say yes. You get the machine back and a note on what was done." },
];

function Home() {
  return (
    <div className="pg" id="top">
      <AsciiEye />

      <header>
        <div className="masthead">
          <a href="#top" className="logo-link" aria-label="AGKBuilds home">
            <AsciiLogo />
          </a>
        </div>
        <HatchBars />
        <div className="wrap navbar">
          <nav aria-label="Primary">
            {navLinks.map((link) => (
              <a key={link.href} className="nav-link" href={link.href}>{link.label}</a>
            ))}
          </nav>
          <a className="btn btn-primary" href="#quote">Request a quote</a>
        </div>
      </header>

      <main>
        <section>
          <div className="wrap hero">
            <div className="col">
              <p className="kicker">San Antonio, TX</p>
              <h1>Tech trouble?<br /><span className="accent">We've got you.</span></h1>
              <p className="hero-intro">AGKBuilds is a San Antonio shop for computer repair, custom PC builds, data recovery, and the tech problems that come with them.</p>
              <div className="hero-actions">
                <a className="btn btn-primary btn-lg" href="#quote">Request a quote <ArrowRight size={18} aria-hidden="true" /></a>
                <a className="mail-link" href={`mailto:${CONTACT_EMAIL}`}><Mail size={18} aria-hidden="true" /> {CONTACT_EMAIL}</a>
              </div>
            </div>
            <div className="col">
              <figure className="photo photo-hero">
                <img src="/photos/repair-bench.webp" alt="Inside a Dell desktop with the side panel off, showing the motherboard, CPU cooler and power supply" width={1400} height={1866} />
                <figcaption>On the bench · Dell desktop open for diagnosis</figcaption>
              </figure>
            </div>
          </div>
          <AsciiFlames frames={HERO_FLAMES} />
        </section>

        <section>
          <div className="wrap">
            <RuleLine />
            <div className="facts">
              {facts.map((fact) => (
                <div key={fact.label}>
                  <p className="fact-label">{fact.label}</p>
                  <p className="fact-text">{fact.text}</p>
                </div>
              ))}
            </div>
            <RuleLine />
          </div>
        </section>

        <section id="services">
          <div className="wrap section-tall">
            <p className="kicker">Services</p>
            <h2>What we fix, build, and recover.</h2>
            <div className="service-grid">
              {services.map(({ icon: Icon, title, text }) => (
                <article className="card" key={title}>
                  <Icon size={30} strokeWidth={1.6} aria-hidden="true" />
                  <h3>{title}</h3>
                  <p>{text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <SparkleDivider />

        <section id="builds">
          <div className="wrap section split">
            <div className="col">
              <figure className="photo photo-build">
                <img src="/photos/custom-build.webp" alt="A Gigabyte motherboard with CPU cooler, RAM and power cables set up on a test bench" width={1400} height={1866} loading="lazy" />
                <figcaption>Test bench · parts checked before assembly</figcaption>
              </figure>
            </div>
            <div className="col">
              <p className="kicker">Custom builds</p>
              <h2>Built for how you actually use it.</h2>
              <p className="lead">Parts are picked with you, assembled cleanly, and tested before the machine leaves the bench. You get a computer that fits your budget and your work.</p>
              <ul className="check-list">
                {buildTypes.map((type) => (
                  <li key={type}><Check size={18} strokeWidth={2.2} aria-hidden="true" />{type}</li>
                ))}
              </ul>
              <a className="btn btn-secondary" href="#quote">Ask about a build</a>
            </div>
          </div>
        </section>

        <SparkleDivider />

        <section id="process" className="band">
          <div className="wrap section-tall">
            <p className="kicker">How it works</p>
            <h2>Three steps, no surprises.</h2>
            <ol className="steps">
              {steps.map((step, index) => (
                <li key={step.title}>
                  <p className="step-number">0{index + 1}</p>
                  <h3>{step.title}</h3>
                  <p className="step-text">{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <SparkleDivider />

        <section id="community">
          <div className="wrap section community">
            <div className="community-copy">
              <p className="kicker">Community</p>
              <h2>Hang out on Discord.</h2>
              <p className="lead">The community lives on Discord. See who is online, jump in, and ask a question about builds, repairs, or anything in between.</p>
            </div>
            <div className="discord-frame">
              <p className="frame-label">Discord · live</p>
              <iframe className="discord-widget" title="Discord server widget" src="https://discord.com/widget?id=1214174485444296764&theme=dark" width="350" height="500" loading="lazy" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts" />
            </div>
          </div>
        </section>

        <SparkleDivider />

        <section id="quote" className="band">
          <div className="wrap section-tall quote">
            <div className="quote-copy">
              <p className="kicker">Contact</p>
              <h2 className="quote-title">Need a fix?<br /><span className="accent">Request a quote.</span></h2>
              <p className="lead">Tell us what is going on and we will get back to you with a plain answer and a price. Prefer email? Write to us directly.</p>
              <a className="mail-link mail-link-lg" href={`mailto:${CONTACT_EMAIL}`}><Mail size={20} aria-hidden="true" /> {CONTACT_EMAIL}</a>
            </div>
            <QuoteForm />
          </div>
          <AsciiFlames frames={BASE_FLAMES} />
        </section>
      </main>

      <footer>
        <HatchBars />
        <div className="wrap footer-row">
          <a href="#top" className="footer-mark">AGK<span className="accent">Builds</span></a>
          <p>San Antonio, TX · © {new Date().getFullYear()} AGKBuilds</p>
          <a className="footer-mail" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </div>
      </footer>
    </div>
  );
}

export default Home;
