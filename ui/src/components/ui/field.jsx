import { cn } from "@/lib/utils"

function FieldSet({ className, ...props }) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  )
}

function FieldLegend({ className, variant = "legend", ...props }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        "text-sm font-medium leading-none",
        variant === "label" && "font-semibold",
        className
      )}
      {...props}
    />
  )
}

function FieldGroup({ className, ...props }) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "flex w-full flex-col gap-5 [&>[data-slot=field]]:w-full",
        className
      )}
      {...props}
    />
  )
}

function Field({ className, orientation = "vertical", ...props }) {
  return (
    <div
      data-slot="field"
      data-orientation={orientation}
      className={cn(
        "group/field flex w-full gap-2 data-[invalid=true]:text-destructive data-[disabled=true]:opacity-50",
        orientation === "horizontal"
          ? "items-center justify-between"
          : "flex-col",
        className
      )}
      {...props}
    />
  )
}

function FieldContent({ className, ...props }) {
  return (
    <div
      data-slot="field-content"
      className={cn("flex flex-1 flex-col gap-1.5", className)}
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }) {
  return (
    <label
      data-slot="field-label"
      className={cn(
        "flex items-center gap-2 text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className
      )}
      {...props}
    />
  )
}

function FieldTitle({ className, ...props }) {
  return (
    <div
      data-slot="field-title"
      className={cn(
        "flex w-fit items-center gap-2 text-sm font-medium leading-snug",
        className
      )}
      {...props}
    />
  )
}

function FieldDescription({ className, ...props }) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        "text-sm font-normal leading-normal text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function FieldError({ className, children, errors, ...props }) {
  const messages = errors
    ?.map((error) => error?.message)
    .filter(Boolean)
    .filter((message, index, all) => all.indexOf(message) === index)

  return (
    <p
      data-slot="field-error"
      role="alert"
      className={cn("text-sm font-normal text-destructive", className)}
      {...props}
    >
      {children ||
        (messages?.length === 1
          ? messages[0]
          : messages?.length > 1 && (
              <ul className="ml-4 flex list-disc flex-col gap-1">
                {messages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ))}
    </p>
  )
}

function FieldSeparator({ className, children, ...props }) {
  return (
    <div
      data-slot="field-separator"
      className={cn("flex items-center gap-3", className)}
      {...props}
    >
      <div className="h-px flex-1 bg-border" />
      {children && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {children}
        </span>
      )}
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
}
