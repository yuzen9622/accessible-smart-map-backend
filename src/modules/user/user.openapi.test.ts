import { describe, expect, it } from "vitest";
import { generateOpenAPIDocument } from "../../openapi/document";

describe("Generated OpenAPI document for auth issuance and session routes", () => {
  const doc = generateOpenAPIDocument();
  const paths = doc.paths;

  const EXPECTED_ROUTES = [
    {
      path: "/user/auth/login",
      method: "post",
      name: "login",
      expectedResponses: ["200", "400", "401", "403", "429"],
    },
    {
      path: "/user/auth/google",
      method: "post",
      name: "googleAuth",
      expectedResponses: ["200", "400", "401", "403", "429"],
    },
    {
      path: "/user/auth/verify-email",
      method: "post",
      name: "verifyEmail",
      expectedResponses: ["200", "400", "401", "403", "429"],
    },
    {
      path: "/user/auth/password/reset",
      method: "post",
      name: "resetPassword",
      expectedResponses: ["200", "400", "401", "403", "429"],
    },
    {
      path: "/user/auth/password",
      method: "post",
      name: "changePassword",
      expectedResponses: ["200", "400", "401", "403", "429"],
    },
    {
      path: "/user/refresh",
      method: "post",
      name: "refresh",
      expectedResponses: ["200", "400", "401", "403", "429"],
    },
    {
      path: "/user/logout",
      method: "post",
      name: "logout",
      expectedResponses: ["200", "400", "401", "403", "429"],
    },
  ] as const;

  for (const route of EXPECTED_ROUTES) {
    describe(`${route.method.toUpperCase()} ${route.path} (${route.name})`, () => {
      const operation = paths[route.path]?.[route.method];

      it("is registered in OpenAPI paths", () => {
        expect(operation).toBeDefined();
      });

      it("documents X-Client header parameter with mobile enum", () => {
        expect(operation?.parameters).toBeDefined();
        const xClientParam = operation?.parameters?.find(
          (p: any) => p.name === "X-Client" && p.in === "header",
        ) as { required?: boolean; schema?: { enum?: string[] } } | undefined;
        expect(xClientParam).toBeDefined();
        expect(xClientParam?.required).toBe(false);
        expect(xClientParam?.schema?.enum).toContain("mobile");
      });

      it("documents body vs cookie and 1d cookie lifetime in description", () => {
        const fullText = `${operation?.description ?? ""} ${JSON.stringify(operation?.responses ?? {})}`;
        expect(fullText).toMatch(/cookie/i);
        expect(fullText).toMatch(/(1d|1 天|1天)/);
        expect(fullText).toMatch(/mobile/i);
      });

      it("documents required status codes 400, 401, 403, 429", () => {
        const responses = operation?.responses ?? {};
        for (const code of route.expectedResponses) {
          expect(
            responses[code],
            `Expected status code ${code} on ${route.path}`,
          ).toBeDefined();
        }
      });
    });
  }
});
