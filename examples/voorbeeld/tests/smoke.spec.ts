import { expect, test } from '@playwright/test';

/**
 * Rooktest die op elke website werkt: staat de pagina er, zonder serverfouten,
 * met een titel en zonder kapotte eigen bestanden?
 */

const SERVER_ERRORS = [/Fatal error\s*:/i, /Parse error\s*:/i, /Uncaught\s+\w*(Error|Exception)/i, /SQLSTATE\[/i, /Traceback \(most recent call last\)/i];

test.describe('Startpagina', () => {
  test('laadt zonder fouten @smoke', async ({ page, baseURL }) => {
    const broken: string[] = [];
    page.on('response', (response) => {
      const sameSite = baseURL && response.url().startsWith(new URL(baseURL).origin);
      if (sameSite && response.status() >= 500) broken.push(`${response.status()} ${response.url()}`);
    });

    const response = await page.goto('/');
    expect(response?.status(), 'HTTP-status van de startpagina').toBeLessThan(400);

    const html = await page.content();
    for (const pattern of SERVER_ERRORS) {
      expect(html, `serverfout op de pagina (${pattern})`).not.toMatch(pattern);
    }
    expect(broken, 'eigen bestanden met een serverfout').toEqual([]);
  });

  test('heeft een titel @smoke', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/\S/);
  });

  test('toont de verwachte tekst', async ({ page }) => {
    const expected = process.env.E2E_EXPECT_TEXT ?? '';
    test.skip(expected === '', 'Zet E2E_EXPECT_TEXT bij het testpakket om dit te controleren.');
    await page.goto('/');
    await expect(page.locator('body')).toContainText(expected);
  });
});

test.describe('Beveiliging', () => {
  test('stuurt X-Content-Type-Options mee @smoke', async ({ request }) => {
    const response = await request.get('/');
    expect(response.headers()['x-content-type-options'] ?? '').toContain('nosniff');
  });

  test('.env is niet op te vragen', async ({ request }) => {
    const response = await request.get('/.env', { maxRedirects: 0 });
    expect([301, 302, 401, 403, 404]).toContain(response.status());
  });
});
