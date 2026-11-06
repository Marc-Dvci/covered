import { Link } from "react-router-dom";

export function HomePage() {
  return (
    <div className="page">
      <div className="stack">
        <h1>Covered: cleaners' pay held before the work starts</h1>
        <p className="lede">
          A cleaning cooperative runs its week on one board. Each household's PayPal holds the visit's pay a day ahead, and whoever does the visit is paid when
          they walk out. When a member calls in sick, an agent finds who can cover, and the money stays with the visit.
        </p>
      </div>
      <div className="row">
        <Link className="btn" to="/board">
          Open the coordinator's board
        </Link>
        <span className="muted">Thursday, 07:10. No login. Every PayPal call is a real sandbox call.</span>
      </div>
      <div className="doors">
        <Link className="door" to="/board">
          <h2>The coordinator</h2>
          <p>Thursday, 07:10: Sam can't come in. See the agent rearrange three homes while every hold stays put.</p>
        </Link>
        <Link className="door" to="/m/teresa">
          <h2>A member's phone</h2>
          <p>Teresa's day in Portuguese: check in, check out, and the pay arriving the same minute.</p>
        </Link>
        <Link className="door" to="/h/okafor">
          <h2>A household's phone</h2>
          <p>The Okafors asked for the same cleaner, so they are asked first. Cancel late and see the fee before you confirm.</p>
        </Link>
        <Link className="door" to="/join">
          <h2>A new household</h2>
          <p>Describe the job, hear the member's terms in their language, sign once, save PayPal once.</p>
        </Link>
      </div>
      <div className="stack">
        <h2>The rule</h2>
        <p>
          The notice window and the payment hold are the same 24 hours. Cancel before it and nothing is held. Cancel inside it and the agreed fee goes to the
          member who kept the morning free. Finish the visit and the member is paid the same minute, with a PayPal record for every line of their income.
        </p>
      </div>
      <p className="fictional">
        The cooperative, its members and its households are fictional. Payments run on the PayPal sandbox; the demo clock moves the day forward so a whole day
        fits in a few minutes.
      </p>
    </div>
  );
}
