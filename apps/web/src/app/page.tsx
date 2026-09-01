import { redirect } from "next/navigation";

/** Signed-out browsers are sent on to `/login` by the authenticated route gate. */
export default function HomePage() {
  redirect("/dashboard");
}
