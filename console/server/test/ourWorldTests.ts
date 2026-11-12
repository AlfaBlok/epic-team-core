// the test files that keep the hosted console's home world (the suite's is the neutral "home", test/neutralOwner.ts):
// the world is read once, when the database module loads in the suite's setup, so a test cannot pin it itself.
// Each one checks our world's own behaviour (its browser instance, its pack, its platform login, the identity).
export const OUR_WORLD_TESTS = new Set([
  "identity.test.ts",
  "instanceMap.test.ts",
  "packRolePersonaTemplates.test.ts",
  "pickWorldRefusesWorld.test.ts",
]);

// the test files that keep the hosted console's memory name and social world (the suite's are "Memory" and "social"):
// hosted modules (the memory service's connections and forward, the desk-to-desk crossing) checked in our words.
export const OUR_MEMORY_TESTS = new Set([
  "automaticRouterOff.test.ts",
  "e42s53.test.ts",
  "lineCardNotePaired.test.ts",
  "partOtherDeskCrosses.test.ts",
  "voiceNoteTranscriptsGo.test.ts",
  "voiceNotesMemorySign.test.ts",
  "voiceNotesPush.test.ts",
  "voiceNotesReachTeam.test.ts",
]);

// the test files that keep the hosted console's ops repo (the suite's is "ops"): the home world's secret backend, the
// approvals mirror and the prompt text checked byte for byte in our words.
export const OUR_OPS_TESTS = new Set([
  "homeOwnerTextByte.test.ts",
  "keyCardMirrorsAnswered.test.ts",
  "pureParts3.test.ts",
  "worldStoreEncryptedPer.test.ts",
]);

// the test files that keep the hosted console's home repo (the suite's is "home_repo"): they check our repo's own
// behaviour (the renamed repo answering both names, its real checkout and spines) or hosted text in our words.
export const OUR_REPO_TESTS = new Set<string>([
  "homeOwnerTextByte.test.ts",
  "identity.test.ts",
  "pureReadyRequestWord.test.ts",
  "workerHostTarget.test.ts",
]);
