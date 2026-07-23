import type { User } from "./auth.js";

export interface DemoUser extends User {
  /** A short human hint about this persona's typical role spread. */
  note: string;
}

/** Fixed demo identities so their tokens and permission rows line up. */
export const DEMO_USERS: DemoUser[] = [
  { userId: "demo-ada", name: "Ada Lovelace", note: "owns most docs" },
  { userId: "demo-ben", name: "Ben Carlisle", note: "edits a few, owns one" },
  { userId: "demo-carol", name: "Carol Nguyen", note: "mostly a viewer" },
];
