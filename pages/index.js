// pages/index.js
import Head from "next/head";
import Link from "next/link";

export default function Home() {
  return (
    <>
      <Head>
        <title>Automated Clarity – HVAC Revenue Control Layer</title>
      </Head>

      <main className="acx-page">
        <div className="acx-shell">
          {/* HERO */}
          <section className="acx-hero-grid">
            <div className="acx-hero-left">
              <div className="acx-kicker">Automated Clarity™ · HVAC</div>
              <h1 className="acx-h1">
                See what your shop is losing
                <br />
                before the next busy day hits.
              </h1>
              <p className="acx-lead">
                Automated Clarity™ runs beneath your HVAC business 24/7 — quietly
                catching missed calls, slow replies and cold quotes so jobs are
                booked before opportunities disappear.
              </p>
              <Link href="/scan" className="acx-btn-primary">
                Start HVAC Opportunity Scan <span>→</span>
              </Link>
            </div>

            <div className="acx-hero-right">
              {/* HERO ORB */}
              <section className="acx-patterns-band">
                <div className="patterns-orb-wrapper">
                  <div className="patterns-orb">
                    <img
                      src="/assets/hero-orb.jpg"
                      alt="Automated Clarity – HVAC clarity"
                      className="patterns-orb-img"
                    />
                  </div>
                </div>
              </section>
            </div>
          </section>
        </div>

        {/* HVAC CHAOS SECTION */}
        <section className="acx-section-dark">
          <div className="acx-shell--dark acx-hero-grid">
            <div className="acx-hero-left">
              <h2 className="acx-h2">HVAC is chaotic by nature.</h2>
              <div className="acx-chaos-lines">
                The phones <span className="accent">jump.</span>
                <br />
                Jobs run <span className="accent">long.</span>
                <br />
                Emergencies blow up the <span className="accent">day.</span>
                <br />
                Follow-ups <span className="accent">disappear.</span>
                <br />
                Opportunities die quietly in{" "}
                <span className="accent">the background.</span>
              </div>
              <p style={{ fontSize: "0.98rem", lineHeight: 1.7, opacity: 0.9 }}>
                Inside that chaos, losses hide in blind spots you never get a
                chance to see. This isn&apos;t a people problem. It&apos;s a{" "}
                <strong>visibility</strong> problem.
              </p>
            </div>

            <div className="acx-hero-right">
              {/* CHAOS ORB */}
              <div className="acx-orb-wrapper">
                <div className="acx-orb">
                  <div className="acx-orb-glow" />
                  <div className="acx-orb-ring" />
                  <div className="acx-orb-ring acx-orb-ring--delay" />

                  <div className="acx-orb-core">
                    <div className="acx-orb-wave" />
                  </div>

                  <div className="acx-orb-brain">
                    <img src="/assets/brain-icon.png" alt="ACX Brain" />
                  </div>

                  <div className="acx-orb-particles">
                    <span className="acx-orb-particle" />
                    <span className="acx-orb-particle" />
                    <span className="acx-orb-particle" />
                    <span className="acx-orb-particle" />
                    <span className="acx-orb-particle" />
                    <span className="acx-orb-particle" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SEE WHAT AC WOULD CATCH */}
        <section className="acx-section-light">
          <div className="acx-shell">
            <h2 className="acx-h2" style={{ marginBottom: "10px" }}>
              See what Automated Clarity™ would catch inside your own shop.
            </h2>
            <p className="acx-small" style={{ maxWidth: "560px" }}>
              It&apos;s a private, 60-second diagnostic that quietly shows you
              how your enquiries move today.
              <br />
              <br />
              No calls. No pitch. No obligations.
              <br />
              Just a clarity snapshot most owners have never seen.
            </p>

            <div style={{ marginTop: "32px" }}>
              <Link href="/scan" className="acx-btn-primary">
                Run HVAC Opportunity Scan <span>→</span>
              </Link>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
