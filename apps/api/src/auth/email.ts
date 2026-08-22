const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const normalizedEmail = normalizeEmail(email);
  return (
    normalizedEmail.length > 0 &&
    normalizedEmail.length <= 320 &&
    EMAIL_PATTERN.test(normalizedEmail)
  );
}
