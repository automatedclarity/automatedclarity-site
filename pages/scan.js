// pages/scan.js
import { useMemo, useState } from "react";
import Head from "next/head";

const QUESTIONS = [
  {
    id: "missedCalls",
    label: "Volume",
    question:
      "On a typical busy week, how many calls does your shop miss or abandon?",
    type: "select",
    options: ["1–3", "4–7", "8–15", "16+"],
  },
  {
    id: "avgJobValue",
    label: "Job value",
    question: "On average, what’s the value of a booked job for you?",
    type: "select",
    options: ["$250–$500", "$500–$900", "$900–$1,500", "$1,500+"],
  },
  {
    id: "quotesUnanswered",
    label: "Quotes",
    question: "Roughly how many written quotes go quiet each week?",
    type: "select",
    options: ["1–3", "4–7", "8–12", "13+"],
  },
  {
    id: "responseSpeed",
    label: "Response",
    question: "How fast does your team usually get back to new enquiries?",
    type: "select",
    options: [
      "Within 15 minutes",
      "Within 1 hour",
      "Same day",
      "Next day or later",
    ],
  },
];

export default function Scan() {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const totalSteps = QUESTIONS.length + 1; // +1 for email/report step
  const isLastQuestion = step === QUESTIONS.length - 1;
  const inResultsStep = step === QUESTIONS.length;

  const progress = useMemo(() => {
    return Math.round(((step + (inResultsStep ? 1 : 0)) / totalSteps) * 100);
  }, [step, inResultsStep, totalSteps]);

  function handleAnswerChange(id, value) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  function goNext() {
    if (step < QUESTIONS.length) {
      setStep((s) => s + 1);
    }
  }

  function goBack() {
    if (step > 0) setStep((s) => s - 1);
  }

  // Simple estimated lost revenue model (placeholder)
  const lossEstimate = useMemo(() => {
    const missedBucket = answers.missedCalls || "";
    const quotesBucket = answers.quotesUnanswered || "";
    const valueBucket = answers.avgJobValue || "";

    const missedMap = { "1–3": 2, "4–7": 5, "8–15": 11, "16+": 18 };
    const quotesMap = { "1–3": 2, "4–7": 5, "8–12": 10, "13+": 16 };
    const valueMap = {
      "$250–$500": 375,
      "$500–$900": 700,
      "$900–$1,500": 1100,
      "$1,500+": 1700,
    };

    const missed = missedMap[missedBucket] || 0;
    const quotes = quotesMap[quotesBucket] || 0;
    const jobValue = valueMap[valueBucket] || 0;

    const weekly = (missed + quotes * 0.7) * jobValue;
    const monthly = weekly * 4;
    const yearly = monthly * 12;

    return {
      weekly,
      monthly,
      yearly,
    };
  }, [answers]);

  async function handleSubmitReport(e) {
    e.preventDefault();
    if (!email) return;

    try {
      setSending(true);
      // TODO: replace "survey" with your actual Netlify function name
      await fetch("/.netlify/functions/survey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers, email, lossEstimate }),
      });
      setSent(true);
    } catch (err) {
      console.error("Error sending survey:", err);
    } finally {
      setSending(false);
    }
  }

  const currentQuestion = QUESTIONS[step];

  return (
    <>
      <Head>
        <title>HVAC Opportunity Scan · Automated Clarity</title>
      </Head>

      <div className="acx-scan-page">
        <div className="acx-scan-shell">
          <header className="acx-scan-header">
            <div>
              <div className="acx-scan-title">HVAC Opportunity Scan</div>
              <div className="acx-scan-sub">
                About 60 seconds. No calls. No obligations.
              </div>
            </div>
            <div style={{ fontSize: "0.85rem", color: "#6b7280" }}>
              Step {inResultsStep ? totalSteps : step + 1} of {totalSteps}
            </div>
          </header>

          <section className="acx-scan-step">
            {!inResultsStep && currentQuestion && (
              <div>
                <div className="acx-question-label">
                  {currentQuestion.label}
                </div>
                <div className="acx-question-text">
                  {currentQuestion.question}
                </div>

                <div className="acx-scan-inputs">
                  {currentQuestion.type === "select" && (
                    <select
                      className="acx-select"
                      value={answers[currentQuestion.id] || ""}
                      onChange={(e) =>
                        handleAnswerChange(
                          currentQuestion.id,
                          e.target.value
                        )
                      }
                    >
                      <option value="">Select an option</option>
                      {currentQuestion.options.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )}

            {inResultsStep && (
              <div>
                <div className="acx-question-label">Clarity snapshot</div>
                <div className="acx-question-text">
                  Here’s what your answers suggest you might be losing quietly.
                </div>

                <div className="acx-results-grid">
                  <div className="acx-result-card">
                    <div className="acx-result-label">Estimated monthly loss</div>
                    <div className="acx-result-value">
                      {lossEstimate.monthly
                        ? `$${lossEstimate.monthly.toLocaleString()}+`
                        : "—"}
                    </div>
                    <div className="acx-result-note">
                      Based on your call, quote and job value patterns.
                    </div>
                  </div>

                  <div className="acx-result-card">
                    <div className="acx-result-label">
                      Estimated yearly loss
                    </div>
                    <div className="acx-result-value">
                      {lossEstimate.yearly
                        ? `$${lossEstimate.yearly.toLocaleString()}+`
                        : "—"}
                    </div>
                    <div className="acx-result-note">
                      This is what stays invisible without a Revenue Control
                      Layer™.
                    </div>
                  </div>

                  <div className="acx-result-card">
                    <div className="acx-result-label">ACX recovery window</div>
                    <div className="acx-result-value">
                      Often 40–80% of this can be recovered.
                    </div>
                    <div className="acx-result-note">
                      Automated Clarity™ follows up automatically and catches
                      missed opportunities before they disappear.
                    </div>
                  </div>
                </div>

                <form
                  onSubmit={handleSubmitReport}
                  style={{ marginTop: "26px", maxWidth: "420px" }}
                >
                  <label
                    htmlFor="acx-email"
                    className="acx-question-label"
                    style={{
                      letterSpacing: "0.09em",
                      textTransform: "uppercase",
                    }}
                  >
                    Send full report
                  </label>
                  <input
                    id="acx-email"
                    type="email"
                    className="acx-field"
                    placeholder="Where should we send your detailed report?"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                  <p className="acx-email-note">
                    You&apos;ll receive a private breakdown of your answers, the
                    math behind this snapshot, and what ACX would automate for
                    you — no sales call attached.
                  </p>
                  <div style={{ marginTop: "16px" }}>
                    <button
                      type="submit"
                      className="acx-btn-primary"
                      disabled={sending || sent}
                    >
                      {sent
                        ? "Report sent"
                        : sending
                        ? "Sending..."
                        : "Send my report"}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </section>

          <footer className="acx-scan-footer">
            <div className="acx-progress-outer">
              <div
                className="acx-progress-inner"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="acx-scan-actions">
              <button
                type="button"
                className="acx-btn-secondary"
                onClick={goBack}
                disabled={step === 0}
              >
                Back
              </button>
              {!inResultsStep && (
                <button
                  type="button"
                  className="acx-btn-primary"
                  onClick={goNext}
                  disabled={!answers[currentQuestion.id]}
                >
                  {isLastQuestion ? "See my snapshot" : "Next"}
                </button>
              )}
            </div>
          </footer>
        </div>
      </div>
    </>
  );
}
