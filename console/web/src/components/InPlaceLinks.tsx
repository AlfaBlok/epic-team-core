import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { installedApp } from "@/components/backArrow";
import { installInPlaceLinks } from "@/lib/inPlaceLinks";

/** In the installed app our own links open in place, so Back returns to the card he clicked; outside sites open a new window (lib/inPlaceLinks). */
export function InPlaceLinks({ installed = installedApp }: { installed?: () => boolean }) {
  const navigate = useNavigate();
  const nav = useRef(navigate);
  nav.current = navigate;
  useEffect(() => (installed() ? installInPlaceLinks((to) => nav.current(to)) : undefined), [installed]);
  return null;
}
