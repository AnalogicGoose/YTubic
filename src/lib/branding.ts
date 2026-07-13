import goosicDevIcon from "../../assets/branding/goosic-icon-dev.svg";

export const APP_NAME = "Goosic";
export const APP_ICON = import.meta.env.DEV
  ? goosicDevIcon
  : "/goosic-icon.svg";
