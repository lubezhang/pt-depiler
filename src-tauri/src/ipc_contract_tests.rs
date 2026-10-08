use super::*;
use std::collections::BTreeMap;
use syn::{visit::Visit, FnArg, GenericArgument, Item, PathArguments, ReturnType, Type};
use ts_rs::TS;

fn type_name(ty: &Type) -> String {
    match ty {
        Type::Tuple(tuple) if tuple.elems.is_empty() => "void".to_string(),
        Type::Path(path) => {
            let segment = path.path.segments.last().unwrap();
            let name = segment.ident.to_string();
            let args: Vec<_> = match &segment.arguments {
                PathArguments::AngleBracketed(args) => args
                    .args
                    .iter()
                    .filter_map(|arg| {
                        if let GenericArgument::Type(ty) = arg {
                            Some(ty)
                        } else {
                            None
                        }
                    })
                    .collect(),
                _ => Vec::new(),
            };
            match name.as_str() {
                "String" => "string".to_string(),
                "bool" => "boolean".to_string(),
                "u16" | "u32" | "u64" | "usize" | "i64" | "f64" => "number".to_string(),
                "Value" => "unknown".to_string(),
                "Option" => format!("{} | null", type_name(args[0])),
                "Vec" => format!("Array<{}>", type_name(args[0])),
                "Result" => type_name(args[0]),
                "FetchRequest" | "FetchResponse" | "CookieInfo" | "DownloadRequest" => name,
                _ => panic!("Unmapped IPC type: {name}; add its Rust DTO binding"),
            }
        }
        _ => panic!("Unsupported IPC type"),
    }
}

fn camel_case(name: &str) -> String {
    let mut parts = name.split('_');
    let mut result = parts.next().unwrap().to_string();
    for part in parts {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            result.extend(first.to_uppercase());
        }
        result.extend(chars);
    }
    result
}

fn commands(source: &str) -> BTreeMap<String, String> {
    syn::parse_file(source)
        .unwrap()
        .items
        .into_iter()
        .filter_map(|item| {
            let Item::Fn(function) = item else {
                return None;
            };
            if !function.attrs.iter().any(|attr| {
                attr.path()
                    .segments
                    .last()
                    .is_some_and(|s| s.ident == "command")
            }) {
                return None;
            }
            let name = function.sig.ident.to_string();
            let input: Vec<_> = function
                .sig
                .inputs
                .iter()
                .filter_map(|arg| {
                    let FnArg::Typed(arg) = arg else {
                        panic!("IPC receiver is unsupported")
                    };
                    if let Type::Path(path) = arg.ty.as_ref() {
                        let name = path.path.segments.last().unwrap().ident.to_string();
                        if ["AppHandle", "WebviewWindow", "State"].contains(&name.as_str()) {
                            return None;
                        }
                    }
                    let syn::Pat::Ident(binding) = arg.pat.as_ref() else {
                        panic!("IPC argument must have a name")
                    };
                    let optional = if let Type::Path(path) = arg.ty.as_ref() {
                        path.path.segments.last().unwrap().ident == "Option"
                    } else {
                        false
                    };
                    Some(format!(
                        "{}{}: {}",
                        camel_case(&binding.ident.to_string()),
                        if optional { "?" } else { "" },
                        type_name(&arg.ty)
                    ))
                })
                .collect();
            let output = match &function.sig.output {
                ReturnType::Default => "void".to_string(),
                ReturnType::Type(_, ty) => type_name(ty),
            };
            let input = if input.is_empty() {
                "Record<string, never>".to_string()
            } else {
                format!("{{ {} }}", input.join("; "))
            };
            Some((
                name.clone(),
                format!("  {name}: {{ input: {input}; output: {output} }};\n"),
            ))
        })
        .collect()
}

#[derive(Default)]
struct RegisteredCommands(Vec<String>);

impl<'ast> Visit<'ast> for RegisteredCommands {
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        if mac
            .path
            .segments
            .last()
            .is_some_and(|s| s.ident == "generate_handler")
        {
            let paths = mac
                .parse_body_with(
                    syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated,
                )
                .unwrap();
            self.0.extend(
                paths
                    .iter()
                    .map(|path| path.segments.last().unwrap().ident.to_string()),
            );
        }
        syn::visit::visit_macro(self, mac);
    }
}

#[test]
fn ap_01_generated_contract_is_current() {
    let root_source = include_str!("lib.rs");
    let mut registered = RegisteredCommands::default();
    registered.visit_file(&syn::parse_file(root_source).unwrap());
    let mut mapped = BTreeMap::new();
    for source in [
        root_source,
        include_str!("http.rs"),
        include_str!("download.rs"),
        include_str!("storage.rs"),
    ] {
        for (name, binding) in commands(source) {
            assert!(
                mapped.insert(name, binding).is_none(),
                "duplicate IPC command"
            );
        }
    }
    assert_eq!(
        registered.0.len(),
        mapped.len(),
        "Unregistered or missing IPC command"
    );
    let mut source = format!(
        "// Generated from Rust DTOs and command signatures. Run PTD_UPDATE_IPC_TYPES=1 cargo test ap_01_generated_contract_is_current to update.\n\nexport {}\nexport {}\nexport {}\nexport {}\nexport {}\nexport {}\nexport {}\n",
        error::AppErrorCode::decl(), error::AppErrorDto::decl(), http::FetchBody::decl(), http::FetchRequest::decl(), http::FetchResponse::decl(), http::CookieInfo::decl(), download::DownloadRequest::decl(),
    );
    source.push_str("\nexport interface IpcCommandMap {\n");
    for name in registered.0 {
        source.push_str(
            mapped
                .get(&name)
                .expect("registered command has no binding"),
        );
    }
    source.push_str("}\n");
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/ipc.ts");
    if std::env::var_os("PTD_UPDATE_IPC_TYPES").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, source).unwrap();
    } else {
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            source,
            "IPC contract drift; regenerate Rust bindings"
        );
    }
}

#[test]
fn ap_01_signature_changes_change_the_binding() {
    let before = commands(
        "#[tauri::command] fn example(request_id: String) -> Result<(), String> { Ok(()) }",
    );
    let after = commands("#[tauri::command] fn example(request_id: String, delay_secs: u64) -> Result<usize, String> { Ok(1) }");
    assert_ne!(before, after);
    assert!(after["example"].contains("delaySecs: number"));
    assert!(after["example"].contains("output: number"));
}
