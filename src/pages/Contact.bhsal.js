// Paste this into the code panel of every page: Home, Games, Stats, Services and Contact.
// It draws that page into the embed box named "leviathPage" and keeps its numbers live.
import { startLeviath } from "public/leviath";

$w.onReady(function () {
    startLeviath($w);
});