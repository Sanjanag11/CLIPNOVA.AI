import { InMemoryLedger } from "../src/ledger";
import { ledgerContract } from "./ledger-contract";

ledgerContract("credit ledger (in memory)", () => new InMemoryLedger());
