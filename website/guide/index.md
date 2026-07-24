# What is spindoctor

spindoctor is a self-hosted tool for qualifying used and refurbished hard
drives before you trust them with data. It runs a fixed health regime per
drive — a SMART snapshot, the drive's own long self-test, a destructive
surface scan (`badblocks -w`), and a second SMART snapshot — and evaluates
the results into a strict **PASS / WARN / FAIL** verdict, all driven from a
live web console.

The rest of the guide (install, how it works, safety, configuration,
architecture) is coming in the next pass.
