/** The first word of a full name, for greetings ("Bonjour, Amel"). */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}
