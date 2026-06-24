import type { FastifyInstance } from "fastify";
import { registerAiRoutes } from "./ai.js";
import { registerAnalyticsRoutes } from "./analytics.js";
import { registerAuthRoutes } from "./auth.js";
import { registerBillingRoutes } from "./billing.js";
import { registerCalendarRoutes } from "./calendar.js";
import { registerCaseRoutes } from "./cases.js";
import { registerClientRoutes } from "./clients.js";
import { registerDocumentRoutes } from "./documents.js";
import { registerDraftRoutes } from "./drafts.js";
import { registerHealthRoutes } from "./health.js";
import { registerMeetingRoutes } from "./meetings.js";
import { registerNotificationRoutes } from "./notifications.js";
import { registerOrganizationRoutes } from "./organizations.js";
import { registerPublicRoutes } from "./public.js";
import { registerTeamRoutes } from "./team.js";

export async function registerRoutes(app: FastifyInstance) {
  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerPublicRoutes(app);
  await registerOrganizationRoutes(app);
  await registerTeamRoutes(app);
  await registerClientRoutes(app);
  await registerCaseRoutes(app);
  await registerDocumentRoutes(app);
  await registerCalendarRoutes(app);
  await registerBillingRoutes(app);
  await registerDraftRoutes(app);
  await registerAiRoutes(app);
  await registerMeetingRoutes(app);
  await registerNotificationRoutes(app);
  await registerAnalyticsRoutes(app);
}
