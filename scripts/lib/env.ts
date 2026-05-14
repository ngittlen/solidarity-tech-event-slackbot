// Side-effect module: loads .env.local before any other lib module reads
// process.env. Other lib modules import this for its side effect; entry
// scripts also import it first to make the dependency explicit.
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });