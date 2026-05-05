#!/usr/bin/env bun
import readline from "node:readline"

const rl = readline.createInterface({ input: process.stdin })
rl.on("line", () => {})

setTimeout(() => process.exit(0), 60_000)
