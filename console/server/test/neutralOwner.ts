// the suite's neutral owner, home world (home), home repo (home_repo), host ids (main, worker), memory name (Memory), social world (social), ops repo (ops), social product (SocialApp; the byte tests of our prompts keep ours), deployer (Deployer) and addresses, set before the hosted layer loads (hostedSetup.ts imports this first): the
// hosted identity and sites fill only what is unset, so a constant a core module builds from them at load reads "Sam"
// and the example.com addresses as well. The customer sites stay the hosted layer's (they are hosted routing).
import path from "node:path";
import { expect } from "vitest";
import { NEUTRAL_SITES, setIdentity, setSites } from "../src/identity.js";
import { OUR_MEMORY_TESTS, OUR_OPS_TESTS, OUR_REPO_TESTS, OUR_WORLD_TESTS } from "./ourWorldTests.js";
const testFile = path.basename(expect.getState().testPath ?? "");
const keepsOurWorld = OUR_WORLD_TESTS.has(testFile);
const keepsOurMemory = OUR_MEMORY_TESTS.has(testFile);
const keepsOurOps = OUR_OPS_TESTS.has(testFile);
const keepsOurRepo = OUR_REPO_TESTS.has(testFile);
setIdentity({ owner: "Sam", ...(keepsOurWorld ? {} : { homeWorld: "home" }), ...(keepsOurRepo ? {} : { homeRepo: "home_repo", org: "Acme" }), mainHost: "main", workerHost: "worker", ...(keepsOurOps ? {} : { opsRepo: "ops", deployer: "Deployer" }), ...(keepsOurMemory ? {} : { memory: "Memory", socialWorld: "social" }), ...(keepsOurMemory || keepsOurOps ? {} : { socialProduct: "SocialApp" }) });
const { teamUrl, socialUrl, tailnetNames, replyVoiceUrl, contact, stateDir, seatDir, reposRoot, hostProvider, pressTest, mainSsh, macListUrl, bookQuestionsUrl, gitEmail } = NEUTRAL_SITES;
// the checkouts every host shares sit at one fixed neutral path in the suite (not the runner's own home)
setSites({ teamUrl, socialUrl, tailnetNames, replyVoiceUrl, contact, stateDir, seatDir, reposRoot: reposRoot || "/srv/agent/github", hostProvider, pressTest, mainSsh, macListUrl, bookQuestionsUrl, gitEmail });
