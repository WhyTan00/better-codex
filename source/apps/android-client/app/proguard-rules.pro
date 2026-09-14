# Keep the small WebView bridge and the service entry point discoverable after
# R8. No reflection-based JSON model is used; org.json DTOs stay reachable from
# their direct call sites.
-keep class com.bettercodex.app.** { *; }
