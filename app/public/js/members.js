// Members page: the Subscribe button links to /members/checkout; ?subscribe=1 brings it into view.
import { $ } from "./api.js";

if (new URLSearchParams(location.search).get("subscribe") === "1") $("#subscribe")?.scrollIntoView({ block: "center" });
