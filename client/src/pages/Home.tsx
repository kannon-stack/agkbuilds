import { useEffect, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Award,
  Brackets,
  Check,
  CircleDot,
  Code2,
  Copy,
  Layers3,
  Mail,
  MapPin,
  Menu,
  Mic2,
  MoveUpRight,
  Radio,
  Terminal,
  X,
} from "lucide-react";

const projects = [
  {
    number: "01",
    kind: "Web / identity",
    title: "Signal / Field Notes",
    description: "A living home base for ideas, work-in-progress, and the useful patterns that emerge between projects.",
    tag: "AGKBUILDS",
    accent: "lime",
  },
  {
    number: "02",
    kind: "Systems / ops",
    title: "Small Batch Systems",
    description: "Lightweight workflows that take the repetitive part out of the day without turning the whole shop into software.",
    tag: "AUTOMATION",
    accent: "mint",
  },
  {
    number: "03",
    kind: "Digital build",
    title: "Northline Toolkit",
    description: "A practical set of reusable building blocks for fast, clear launches when the brief is still finding its shape.",
    tag: "TOOLING",
    accent: "amber",
  },
  {
    number: "04",
    kind: "Brand / web",
    title: "The Useful Internet",
    description: "A sharper visual language for work that needs to feel human, capable, and ready for the real world.",
    tag: "DIRECTION",
    accent: "purple",
  },
  {
    number: "05",
    kind: "Research / making",
    title: "Long Way Round",
    description: "A field study in taking the scenic route: observe first, make a smaller thing, then keep what holds up.",
    tag: "EXPERIMENT",
    accent: "blue",
  },
  {
    number: "06",
    kind: "Client / delivery",
    title: "Workbench 06",
    description: "A repeatable way to turn a loose problem into a clean next step, a working artifact, and a handoff that lasts.",
    tag: "PROCESS",
    accent: "pink",
  },
];

const experience = [
  {
    year: "NOW",
    role: "Sole proprietor / AGKBUILDS",
    scope: "Texas · independent practice",
    detail: "Building useful things across digital systems, visual direction, operations, and the gaps between them.",
  },
  {
    year: "01—",
    role: "Multi-disciplinary operator",
    scope: "Projects · field notes · independent work",
    detail: "The throughline: learn the landscape quickly, make the messy part legible, and leave behind something people can actually use.",
  },
  {
    year: "NEXT",
    role: "Open to the right problem",
    scope: "Remote · Texas · wherever the signal is",
    detail: "Looking for work with a little texture: a smart team, a real constraint, and room to make the answer better than the brief.",
  },
];

const recognition = [
  { icon: Mic2, label: "TALKS", title: "Not a keynote person (yet).", detail: "More interested in useful notes, honest demos, and the question after the room clears.", state: "IN PROGRESS" },
  { icon: Award, label: "AWARDS", title: "Curiosity, shipped work, repeat trust.", detail: "The best recognition is a project that keeps working after the handoff.", state: "ONGOING" },
  { icon: Radio, label: "SIGNAL", title: "Independent by design.", detail: "Small practice, wide range, no black box between the question and the work.", state: "ACTIVE" },
];

function MatrixGlyphs() {
  const glyphs = ["01", "//", "[]", "<> ", "++", "::", "TX", "AG", "07", "_", "=", "{}"];
  return (
    <div className="matrix-glyphs" aria-hidden="true">
      {Array.from({ length: 18 }).map((_, index) => (
        <div className="glyph-column" key={index} style={{ ["--delay" as string]: `${(index % 7) * -1.2}s`, ["--speed" as string]: `${10 + (index % 5) * 2}s` }}>
          {Array.from({ length: 9 }).map((__, glyphIndex) => (
            <span key={glyphIndex}>{glyphs[(index + glyphIndex * 3) % glyphs.length]}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

function SectionLabel({ index, children }: { index: string; children: string }) {
  return (
    <div className="section-label">
      <span className="section-index">{index}</span>
      <span>{children}</span>
    </div>
  );
}

function Home() {
  const heroRef = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;

    const move = (event: PointerEvent) => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || window.matchMedia("(pointer: coarse)").matches) return;
      const bounds = hero.getBoundingClientRect();
      const x = ((event.clientX - bounds.left) / bounds.width) * 100;
      const y = ((event.clientY - bounds.top) / bounds.height) * 100;
      hero.style.setProperty("--pointer-x", `${x}%`);
      hero.style.setProperty("--pointer-y", `${y}%`);
      hero.style.setProperty("--hero-rotate-x", `${(50 - y) * 0.035}deg`);
      hero.style.setProperty("--hero-rotate-y", `${(x - 50) * 0.035}deg`);
    };

    hero.addEventListener("pointermove", move);
    return () => hero.removeEventListener("pointermove", move);
  }, []);

  const copyEmail = async () => {
    await navigator.clipboard?.writeText("hello@agkbuilds.com");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const closeMenu = () => setMenuOpen(false);

  return (
    <main className="site-shell">
      <header className="site-header">
        <a className="wordmark" href="#top" onClick={closeMenu} aria-label="AGKBUILDS home">
          <span className="wordmark-cursor" aria-hidden="true">_</span>
          <span>AGK</span><strong>BUILDS</strong>
          <span className="wordmark-meta">TX // 01</span>
        </a>
        <nav className={menuOpen ? "site-nav is-open" : "site-nav"} aria-label="Primary navigation">
          <a href="#work" onClick={closeMenu}>Work <span>01</span></a>
          <a href="#about" onClick={closeMenu}>About <span>02</span></a>
          <a href="#experience" onClick={closeMenu}>Experience <span>03</span></a>
          <a href="#contact" onClick={closeMenu}>Contact <span>04</span></a>
        </nav>
        <button className="menu-toggle" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen}>
          {menuOpen ? <X size={19} /> : <Menu size={19} />}
        </button>
        <a className="header-status" href="#contact"><span className="status-dot" /> available for a good problem</a>
      </header>

      <section className="hero" id="top" ref={heroRef}>
        <MatrixGlyphs />
        <div className="hero-signal" aria-hidden="true" />
        <div className="hero-grid" aria-hidden="true" />
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-prompt">&gt;_</span> independent builder / texas</p>
          <h1>I make the<br /><span className="h1-outline">complicated</span><br /><span className="h1-signal">useful<span className="blink">_</span></span></h1>
          <p className="hero-intro">I’m Dylan Borgen — the one-person practice behind AGKBUILDS. I move between code, systems, visual direction, and hands-on problem solving.</p>
          <div className="hero-actions">
            <a className="button button-primary" href="#work">See selected work <ArrowDownRight size={16} /></a>
            <a className="text-link" href="#about">How I work <ArrowUpRight size={15} /></a>
          </div>
        </div>
        <div className="hero-card-wrap" aria-hidden="true">
          <div className="hero-card">
            <div className="hero-card-top"><span>AGK / SYSTEM ONLINE</span><span className="hero-card-live"><span className="status-dot" /> LIVE</span></div>
            <div className="hero-card-mark"><Brackets size={32} strokeWidth={1.2} /><span>build<br />something<br /><em>useful</em></span></div>
            <div className="hero-card-bottom"><span>TEXAS</span><span>INDEPENDENT</span><span>v.01</span></div>
          </div>
          <div className="hero-card-caption">cursor-sensitive interface / move around</div>
        </div>
        <div className="hero-footer"><span>SCROLL TO EXPLORE</span><span className="scroll-line" /><span>001 / 005</span></div>
      </section>

      <section className="statement section-pad">
        <div className="statement-mark" aria-hidden="true"><span>AGK</span><span>+</span><span>∞</span></div>
        <div className="statement-copy"><SectionLabel index="00" children="A quick read" /><h2>Good work should survive contact with the <span>real world.</span></h2></div>
        <div className="statement-aside"><p>I’m drawn to the space between the idea and the thing: the system, the story, the interface, the next practical move.</p><a href="#contact" className="text-link">Start a conversation <ArrowUpRight size={15} /></a></div>
      </section>

      <section className="about section-pad" id="about">
        <div className="section-heading"><SectionLabel index="01" children="About / operating system" /><span className="heading-note">NOT A GENERALIST. A USEFUL SPECIALIST.</span></div>
        <div className="bento-grid">
          <article className="bento-card bento-main">
            <div className="bento-icon"><Terminal size={20} /></div><span className="card-kicker">// 01 / THE SHORT VERSION</span>
            <h3>Wide range.<br /><span>Clear point of view.</span></h3>
            <p>AGKBUILDS is a small, independent practice built for the messy middle — when the brief is fuzzy, the timeline is real, and the answer needs both taste and follow-through.</p>
            <div className="card-foot"><span>01—06</span><span>KEEP IT MOVING <ArrowUpRight size={14} /></span></div>
          </article>
          <article className="bento-card bento-signal"><div className="signal-orbit"><span className="orbit-core">AGK</span><span className="orbit-ring ring-one" /><span className="orbit-ring ring-two" /></div><span className="card-kicker">// CURRENT SIGNAL</span><h4>Curious, calm,<br /><em>resourceful.</em></h4><span className="mini-caption">the working trio</span></article>
          <article className="bento-card bento-location"><MapPin size={18} /><span className="card-kicker">// BASED IN</span><strong>Texas</strong><span className="mini-caption">working wherever the signal is</span></article>
          <article className="bento-card bento-stack"><span className="card-kicker">// THE STACK IS A MOVING TARGET</span><div className="stack-list"><span><Code2 size={14} /> code</span><span><Layers3 size={14} /> systems</span><span><Brackets size={14} /> direction</span><span><CircleDot size={14} /> making</span></div></article>
          <article className="bento-card bento-note"><span className="quote-mark">“</span><p>Make the complicated part legible. Then make it feel obvious.</p><span className="mini-caption">operating principle / 001</span></article>
        </div>
      </section>

      <section className="work section-pad" id="work">
        <div className="section-heading"><SectionLabel index="02" children="Selected work" /><span className="heading-note">SIX WAYS TO MAKE THE NEXT STEP CLEARER</span></div>
        <div className="projects-grid">{projects.map((project) => <article className={`project-card accent-${project.accent}`} key={project.number}><div className="project-top"><span className="project-number">{project.number}</span><span className="project-kind">{project.kind}</span><ArrowUpRight className="project-arrow" size={18} /></div><div className="project-visual"><span className="visual-mark">{project.number === "01" ? "//" : project.number === "02" ? "[]" : project.number === "03" ? "<>" : project.number === "04" ? "✳" : project.number === "05" ? "↗" : "∞"}</span><span className="visual-grid" /></div><div className="project-bottom"><div><h3>{project.title}</h3><p>{project.description}</p></div><span className="project-tag">{project.tag}</span></div></article>)}</div>
      </section>

      <section className="experience section-pad" id="experience">
        <div className="section-heading"><SectionLabel index="03" children="Experience / timeline" /><span className="heading-note">THE LONG VERSION, IN SHORT</span></div>
        <div className="timeline">{experience.map((item, index) => <article className="timeline-row" key={item.year}><div className="timeline-year">{item.year}</div><div className="timeline-marker"><span className={index === 0 ? "marker-dot active" : "marker-dot"} /></div><div className="timeline-content"><h3>{item.role}</h3><span className="timeline-scope">{item.scope}</span><p>{item.detail}</p></div><div className="timeline-index">0{index + 1}</div></article>)}</div>
      </section>

      <section className="recognition section-pad" id="recognition">
        <div className="section-heading"><SectionLabel index="04" children="Talks / awards / signal" /><span className="heading-note">THE RECEIPTS ARE IN THE WORK</span></div>
        <div className="recognition-grid">{recognition.map((item) => { const Icon = item.icon; return <article className="recognition-card" key={item.label}><div className="recognition-icon"><Icon size={17} /></div><div><span className="card-kicker">// {item.label}</span><h3>{item.title}</h3><p>{item.detail}</p></div><span className="recognition-state"><span className="status-dot" /> {item.state}</span></article>; })}</div>
      </section>

      <section className="contact section-pad" id="contact">
        <div className="contact-panel"><MatrixGlyphs /><div className="contact-content"><SectionLabel index="05" children="Contact / open channel" /><h2>Have a messy one?<br /><span>Send it over.</span></h2><p>The good kind of brief has a little friction in it. Tell me what you’re working on, what’s stuck, or what you wish existed.</p><div className="contact-actions"><a className="button button-primary" href="mailto:hello@agkbuilds.com">hello@agkbuilds.com <ArrowUpRight size={16} /></a><button className="copy-button" onClick={copyEmail}>{copied ? <><Check size={15} /> copied</> : <><Copy size={15} /> copy email</>}</button></div></div><div className="contact-side"><span className="contact-side-label">AGKBUILDS / TX</span><div className="contact-glyph"><Brackets size={45} strokeWidth={1} /></div><span className="contact-side-note">No gatekeepers.<br />Just a clear next step.</span></div></div>
      </section>

      <footer className="site-footer"><a className="wordmark" href="#top"><span className="wordmark-cursor">_</span><span>AGK</span><strong>BUILDS</strong></a><span className="footer-copy">© {new Date().getFullYear()} Dylan Borgen. Built in Texas, with intent.</span><div className="footer-links"><a href="mailto:hello@agkbuilds.com" aria-label="Email"><Mail size={16} /></a></div><a className="back-top" href="#top">BACK TO TOP <MoveUpRight size={14} /></a></footer>
    </main>
  );
}

export default Home;
