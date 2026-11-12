import { act, render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { AppRoutes } from "@/App";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";

/** where an old path leads in a skin (social: the campaign's tab, Team or Personas). Renders the app and reads the location. */
export async function landsAt(path: string, skin: Skin = SKINS.social): Promise<string> {
  let at = "";
  function Probe() {
    const l = useLocation();
    at = l.pathname + l.search;
    return null;
  }
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <Probe />
        <AppRoutes />
      </MemoryRouter>
    </SkinProvider>,
  );
  for (let i = 0; i < 40 && at === path; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  return at;
}
