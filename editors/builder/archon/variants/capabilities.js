export const VARIANT_CAPABILITIES = {
    prompt: { honorsAiFields: true },
    command: { honorsAiFields: true },
    // Loop forwards model/provider to each iteration's AI call but rejects retry.
    loop: { honorsAiFields: true, forbidsRetry: true },
    // Approval is a human gate; it makes no provider call (no AI fields).
    approval: { honorsAiFields: false, pausesRun: true },
    wait: { honorsAiFields: false },
    // bash/script/cancel make no provider call — AI fields are meaningless on them.
    bash: { honorsAiFields: false },
    script: { honorsAiFields: false },
    cancel: { honorsAiFields: false },
};
