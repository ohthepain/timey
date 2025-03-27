import { useEffect } from "react";
import TempoService from "./TempoService";

export const useTempoService = () => {
  useEffect(() => {
    console.log("Starting TempoService...");
    TempoService.start();

    return () => {
      console.log("Stopping TempoService...");
      TempoService.stop();
    };
  }, []);
};
