.PHONY: help install build typecheck lint test clean pack-check run

help:
	@printf '%s\n' \
		'Available targets:' \
		'  make install      Install dependencies' \
		'  make build        Build the project' \
		'  make typecheck    Run TypeScript typecheck' \
		'  make lint         Run eslint' \
		'  make test         Run test suite' \
		'  make clean        Run repo hygiene cleanup' \
		'  make pack-check   Run package budget check' \
		'  make run ARGS="" Run codex-multi-auth CLI entrypoint'

install:
	npm ci

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

test:
	npm test

clean:
	npm run clean:repo

pack-check:
	npm run pack:check

run:
	node scripts/codex-multi-auth.js $(ARGS)
