// the screens read ticket rows from the ticket index (tickets/ticketIndex.ts). Tests write fixture spines on disk
// and read them back at once, so here the index is a stand-in that reads each file's rows as written; that the real
// index (scripts/ticket_index.py) holds exactly these rows is test/ticketIndex.test.ts's job (file by file, built for real).
import fs from "node:fs";
import { ledgerLines } from "../src/review/rows.js";
import { setTicketIndex } from "../src/tickets/ticketIndex.js";

setTicketIndex({
  lines: (abs) => {
    try {
      return ledgerLines(fs.readFileSync(abs, "utf8"));
    } catch {
      return [];
    }
  },
  refresh: async () => {},
  version: () => String(Date.now()),
  tickets: () => [],
  stats: () => undefined,
});
