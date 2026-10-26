package org.opentripplanner.runtime.policyidentity;

import java.util.Arrays;

/** Trusted entry point: verification precedes initialization of application main. */
public final class TrustedPolicyLauncher {
  private TrustedPolicyLauncher() {}
  public static void main(String[] args) throws Exception {
    if (args.length == 0) throw new IllegalArgumentException("application main class required");
    var identity = RuntimePolicyIdentity.verifyConfigured(ClassLoader.getSystemClassLoader());
    if (!"VERIFIED_OBSERVED_POLICY_CLASSES".equals(identity.status())) {
      throw new IllegalStateException("TRUSTED_LAUNCH_REQUIRES_VERIFIED_POLICY: " + identity.reason());
    }
    Class<?> target = Class.forName(args[0], false, ClassLoader.getSystemClassLoader());
    target.getMethod("main", String[].class).invoke(null, (Object) Arrays.copyOfRange(args, 1, args.length));
  }
}
