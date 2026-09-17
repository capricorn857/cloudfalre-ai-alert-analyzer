import { z } from "zod";

export const ZonedDateTimeSchema = z.iso.datetime({ offset: true });
export const UtcDateTimeSchema = z.iso.datetime({ offset: false }).refine((value) => value.endsWith("Z"), {
  message: "timestamp must be UTC",
});
