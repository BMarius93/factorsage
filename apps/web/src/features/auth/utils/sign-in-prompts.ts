import type { SignInPromptCopy } from "../hooks/use-sign-in-prompt";

/**
 * The prompt a Guest sees on any "backtest this" action: the Dashboard card, a built-in strategy
 * and a built-in monitor. One constant, so the three places cannot drift into three wordings.
 *
 * "You will come straight back here" is a promise the sign-in flow keeps: the prompt's links
 * carry the current page as `?next=`, and both password and Google sign-in return to it (UX-003).
 */
export const SIGN_IN_TO_BACKTEST: SignInPromptCopy = {
  title: "Sign in to run a backtest",
  body: "A backtest belongs to an account: it runs in the background, keeps its results and stays reproducible. Sign in or create an account to run one — you will come straight back here.",
};
