// What a first-time visitor should do next in Thursday's story, read from the demo's real state.
export interface GuideVisit {
  id: string;
  state: string;
  pendingMember: string | null;
}

export interface GuideState {
  disruptions: { memberId: string; status: string; affected: string[] }[];
  visits: GuideVisit[];
  now: number;
}

const THU = 3 * 1440;
const AT_0900 = THU + 9 * 60;
const AT_1305 = THU + 13 * 60 + 5;
const AT_1330 = THU + 13 * 60 + 30;

export interface Step {
  n: number;
  text: string;
  clockTo?: number;
  link?: { to: string; label: string };
}

export const STEP_COUNT = 7;

/** The next thing to do in Thursday's story, or null once a visitor has left the story's path. */
export function nextStep(b: GuideState): Step | null {
  const okafor = b.visits.find((v) => v.id === "v-thu-okafor");
  const lindqvist = b.visits.find((v) => v.id === "v-thu-lindqvist");
  if (!okafor || !lindqvist) return null;
  const sam = b.disruptions.find((d) => d.memberId === "sam" && d.status !== "dismissed" && d.affected.length > 0);
  if (!sam) return { n: 1, text: "07:10. Sam's message is ready on the right: send it." };
  if (sam.status === "open") return { n: 2, text: "Sam has three homes today. Ask the agent to find cover." };
  if (sam.status === "proposed") return { n: 3, text: "The dashed bars are the agent's plan, from the solver's valid plans. Every hold stays where it is. Approve it." };
  if (okafor.pendingMember) return { n: 4, text: "The Okafors asked for the same cleaner, so they decide.", link: { to: "/h/okafor", label: "Open the Okafors' phone" } };
  if (okafor.state === "held") {
    return b.now < AT_0900
      ? { n: 5, text: "Marek is on his way to the Okafors.", clockTo: AT_0900, link: { to: "/m/marek", label: "Then check in on Marek's phone" } }
      : { n: 5, text: "Marek is at the door.", link: { to: "/m/marek", label: "Check in on Marek's phone" } };
  }
  if (okafor.state === "in_progress") {
    return b.now < AT_1305
      ? { n: 5, text: "Marek finishes at 13:05.", clockTo: AT_1305, link: { to: "/m/marek", label: "Then check out on Marek's phone" } }
      : { n: 5, text: "Marek is done.", link: { to: "/m/marek", label: "Check out on Marek's phone" } };
  }
  if (okafor.state === "settling") return { n: 5, text: "Capturing on PayPal, then paying Marek through Payouts: about half a minute on the sandbox." };
  if (["scheduled", "holding", "held", "at_risk"].includes(lindqvist.state)) {
    return b.now < AT_1330
      ? { n: 6, text: "Marek is paid. At 13:30 Mr. Lindqvist cancels his 14:00 visit.", clockTo: AT_1330, link: { to: "/h/lindqvist", label: "Then cancel on his phone" } }
      : { n: 6, text: "Mr. Lindqvist cancels half an hour before his visit.", link: { to: "/h/lindqvist", label: "Cancel on his phone" } };
  }
  if (lindqvist.state === "settling") return { n: 6, text: "Capturing the fee and releasing the rest of the hold, then paying Marek for the afternoon he kept free." };
  return { n: 7, text: "Every dollar is on PayPal. Marek can prove his income with a link for his landlord.", link: { to: "/m/marek/statement", label: "Open Marek's statement" } };
}

