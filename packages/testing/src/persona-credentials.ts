import { getTestPersonaCredentials } from "@intrinsic/config";
import {
  TEST_PERSONAS,
  TEST_PERSONA_LIST,
  personaCredentialEnvNames,
  type TestPersona,
  type TestPersonaName,
} from "./personas.js";

/**
 * A persona with the credentials the environment supplies for it.
 *
 * Kept out of `personas.ts` on purpose: that module is imported by the Playwright harness through
 * a dependency-free subpath, and reading configuration would drag `@intrinsic/config` into a
 * browser-test bundle for no reason. The registry is shared; how each side obtains the secret is
 * not.
 */
export type ResolvedTestPersona = TestPersona & {
  readonly email: string;
  readonly password: string;
};

/**
 * Resolves one persona's credentials, or fails naming the variable that is missing.
 *
 * The value is never echoed — only the variable name — so a misconfiguration is actionable
 * without printing a secret.
 */
export function resolveTestPersona(
  name: TestPersonaName,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTestPersona {
  const persona = TEST_PERSONAS[name];
  const { email, password } = getTestPersonaCredentials(
    persona.envPrefix,
    env,
  );
  return { ...persona, email, password };
}

/** Every persona, resolved. Used by the seeders, which reconcile all of them together. */
export function resolveAllTestPersonas(
  env: NodeJS.ProcessEnv = process.env,
): readonly ResolvedTestPersona[] {
  return TEST_PERSONA_LIST.map((persona) =>
    resolveTestPersona(persona.name, env),
  );
}

/** The environment variables every persona needs, for documentation and error messages. */
export function testPersonaEnvNames(): readonly string[] {
  return TEST_PERSONA_LIST.flatMap((persona) => {
    const names = personaCredentialEnvNames(persona);
    return [names.email, names.password];
  });
}
