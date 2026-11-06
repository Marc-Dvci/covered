# Security

Please report a vulnerability through
[GitHub's private reporting](https://github.com/Marc-Dvci/covered/security/advisories/new), not in a public issue.
The supported version is the `main` branch and the hosted [live demo](https://covered-coop.pages.dev).

The live demo runs on the PayPal sandbox with fictional people, so no real money or personal data is at stake. The
reports that matter most are anything that:

- makes a settlement capture or pay twice, or pay someone other than the member who did the visit;
- gets a model's words past the number checks into a message or an agreement read-back;
- gets an unverified PayPal webhook recorded as PayPal's;
- opens a landlord link without its signature, or shows a household's name or address through one;
- reads the server's API keys, or spends the model allowance past its daily cap.
