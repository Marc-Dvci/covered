import { NavLink, Link } from "react-router-dom";

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#14213d" />
      <path d="M8 17.5l5 5L24 10" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Top() {
  return (
    <header className="top">
      <Link className="brand" to="/">
        <Logo />
        Covered
      </Link>
      <nav aria-label="Main">
        <NavLink to="/board">Coordinator</NavLink>
        <NavLink to="/m/teresa">Member phone</NavLink>
        <NavLink to="/h/okafor">Household phone</NavLink>
        <NavLink to="/join">New household</NavLink>
        <NavLink to="/about">Evidence</NavLink>
      </nav>
      <span className="spacer" />
      <span className="fictional">Every person shown is fictional. Payments run on the PayPal sandbox.</span>
    </header>
  );
}
