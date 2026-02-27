# Contributing Guidelines

Thank you for your interest in contributing to codex-multi-auth!

Before submitting contributions, please review these guidelines to ensure all changes maintain compliance with OpenAI's Terms of Service and the project's goals.

## Compliance Requirements

All contributions MUST:

✅ **Maintain TOS Compliance**
- Use only official OAuth authentication methods
- Not facilitate violations of OpenAI's Terms of Service
- Focus on legitimate personal productivity use cases
- Include appropriate user warnings and disclaimers

✅ **Respect OpenAI's Systems**
- No session token scraping or cookie extraction
- No bypassing of rate limits or authentication controls
- No reverse-engineering of undocumented APIs
- Use only officially supported authentication flows

✅ **Proper Use Cases**
- Personal development and coding assistance
- Individual productivity enhancements
- Terminal-based workflows
- Educational purposes

❌ **Prohibited Features**
- Commercial resale or multi-user authentication
- Rate limit circumvention techniques
- Session token scraping or extraction
- Credential sharing mechanisms
- Features designed to violate OpenAI's terms

## Code Standards

- **TypeScript:** All code must be TypeScript with strict type checking
- **Testing:** Include tests for new functionality and keep coverage gate healthy (80% threshold)
- **Documentation:** Update README.md for user-facing changes
- **Validation gate:** Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` before opening a PR
- **Dependencies:** Minimize new dependencies and justify them in the PR

## Pull Request Process

1. **Fork the repository** and create a feature branch
2. **Write clear commit messages** explaining the "why" not just "what"
3. **Include tests** for new functionality
4. **Update documentation** (README.md, config examples, etc.)
5. **Ensure compliance** with guidelines above
6. **Run the validation gate** (`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`)
7. **Submit PR** with clear description of changes

## Reporting Issues

When reporting issues, please:

- **Check existing issues** to avoid duplicates
- **Provide clear reproduction steps**
- **Include version information** (`codex --version`, plugin version)
- **Confirm compliance:** Verify you're using the plugin for personal use with your own subscription
- **Attach logs** (if using `ENABLE_PLUGIN_REQUEST_LOGGING=1`)

### Issue Template

Please include:
```
**Issue Description:**
[Clear description of the problem]

**Steps to Reproduce:**
1.
2.
3.

**Expected Behavior:**
[What should happen]

**Actual Behavior:**
[What actually happens]

**Environment:**
- codex version:
- Plugin version:
- OS:
- Node version:

**Compliance Confirmation:**
- [ ] I'm using this for personal development only
- [ ] I have an active ChatGPT Plus/Pro subscription
- [ ] This is not related to commercial use or TOS violations
```

## Feature Requests

We welcome feature requests that:
- Enhance personal productivity
- Improve developer experience
- Maintain compliance with OpenAI's terms
- Align with the project's scope

We will decline features that:
- Violate or circumvent OpenAI's Terms of Service
- Enable commercial resale or multi-user access
- Bypass authentication or rate limiting
- Facilitate improper use

## Code of Conduct

### Our Standards

✅ **Encouraged:**
- Respectful and constructive communication
- Focus on legitimate use cases
- Transparency about limitations and compliance
- Helping other users with proper usage

❌ **Not Acceptable:**
- Requesting help with TOS violations
- Promoting commercial misuse
- Hostile or disrespectful behavior
- Sharing credentials or tokens

## Questions?

For questions about:
- **Plugin usage:** Open a GitHub issue
- **OpenAI's terms:** Contact OpenAI support
- **Contributing:** Open a discussion thread

## License

By contributing, you agree that your contributions will be licensed under the MIT License with Usage Disclaimer (see LICENSE file).

---

Thank you for helping make this plugin better while maintaining compliance and ethics!
